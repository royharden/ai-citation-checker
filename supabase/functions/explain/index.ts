import { z } from "npm:zod@3.23.8";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Thrown for any request that should end with a specific status + JSON body
class HttpError extends Error {
  constructor(readonly status: number, readonly payload: Record<string, unknown>) {
    super(String(payload.error ?? status));
    this.name = "HttpError";
  }
}

// ---------- Input limits ----------
const MAX_BODY_BYTES = 300 * 1024;
const MAX_CLAIM_CHARS = 2_000;
const MAX_PASSAGE_CHARS = 2_000;
const MAX_CODE_CHECKS_CHARS = 5_000;
const VERDICTS = new Set(["supported", "partially_supported", "unsupported", "contradicted", "misquoted", "uncertain"]);

async function readJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, { error: "Request body is too large (max 300 KB)" });
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, { error: "Request body is too large (max 300 KB)" });
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { buf.set(c, pos); pos += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

// ---------- Daily usage cap (one increment right before every OpenAI call, fail closed) ----------
const DEFAULT_DAILY_CALL_LIMIT = 200;
let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient | null {
  if (supabaseAdmin) return supabaseAdmin;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return null;
  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabaseAdmin;
}

function dailyCallLimit(): number {
  const raw = (Deno.env.get("DAILY_CALL_LIMIT") ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_DAILY_CALL_LIMIT;
}

// Throws HttpError 429 { error: "daily_limit" } over the cap, 503 if the counter can't be trusted
async function consumeDailyCall(fn: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error(`[${fn}] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set; refusing upstream call`);
    throw new HttpError(503, { error: "Service unavailable: usage counter is not configured" });
  }
  const today = new Date().toISOString().slice(0, 10);
  let count: unknown;
  try {
    const { data, error } = await admin.rpc("increment_usage", { fn, day: today });
    if (error) {
      console.error(`[${fn}] increment_usage failed`, error);
      throw new HttpError(503, { error: "Service unavailable: usage counter error" });
    }
    count = data;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error(`[${fn}] increment_usage threw`, e);
    throw new HttpError(503, { error: "Service unavailable: usage counter error" });
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    console.error(`[${fn}] increment_usage returned a non-integer result`, count);
    throw new HttpError(503, { error: "Service unavailable: usage counter error" });
  }
  if (count > dailyCallLimit()) throw new HttpError(429, { error: "daily_limit" });
}

const explainSchema = z.object({
  reasoning: z.string().min(1).max(600),
  suggested_fix: z.string().nullable(),
});

const SYSTEM_PROMPT = `You explain citation-check verdicts to a non-technical reader.

You receive a claim, the source passage that was matched to it, the final verdict, and code checks (quote and number comparisons).

Rules:
- NEVER re-decide or contradict the verdict. Your job is only to explain it.
- Reasoning: 1-2 sentences, plain language. Only restate facts that are present in the passage. Never add outside knowledge.
- suggested_fix: if the passage supports a corrected version of the claim, provide that corrected claim text. Only use facts from the passage. If no correction is possible from the passage, return null.
- Return JSON: {"reasoning": "...", "suggested_fix": "..." | null}`;

const MAX_ATTEMPTS = 2;
const OPENAI_TIMEOUT_MS = 55_000;

// Upstream failure; the message is safe for clients (no upstream response text)
class UpstreamError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "UpstreamError";
  }
}

async function chatJson(apiKey: string, baseUrl: string, model: string, messages: { role: string; content: string }[]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error("[explain] OpenAI fetch failed", e);
    if (controller.signal.aborted) throw new UpstreamError("OpenAI request timed out", false);
    throw new UpstreamError("Could not reach OpenAI", true);
  }
  try {
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[explain] OpenAI returned ${res.status}: ${detail.slice(0, 500)}`);
      if (res.status === 401) throw new UpstreamError("OpenAI rejected the API key (401)", false);
      if (res.status === 429 || res.status === 529) throw new UpstreamError(`OpenAI rate limit reached (${res.status})`, true);
      throw new UpstreamError(`OpenAI request failed (${res.status})`, false);
    }
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new UpstreamError("OpenAI returned no message content", false);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

interface LooseCodeChecks {
  number?: { mismatch?: unknown; passage_value?: unknown; claim_value?: unknown } | null;
  quote?: { status?: unknown; similarity?: unknown } | null;
}

function mockExplain(claim: string, passage: string, verdict: string, codeChecks: unknown): { reasoning: string; suggested_fix: string | null } {
  const checks = (codeChecks ?? {}) as LooseCodeChecks;
  const numberNote = checks?.number?.mismatch
    ? ` The passage reports ${checks.number.passage_value} where the claim says ${checks.number.claim_value}.`
    : "";
  const quoteNote = checks?.quote?.status === "exact"
    ? " The quoted words appear in the passage."
    : checks?.quote?.status === "close"
      ? ` The quote is a close paraphrase (${checks.quote.similarity}%) rather than exact.`
      : "";
  const verdictLine: Record<string, string> = {
    supported: "The passage states the facts in this claim.",
    partially_supported: "The passage backs up part of the claim, but some detail is missing or overstated.",
    unsupported: "The passage does not mention what the claim says.",
    contradicted: "The passage says the opposite of the claim.",
    misquoted: "The quotation does not match the words or meaning in the passage.",
    uncertain: "There is not enough information in the passage to decide.",
  };
  const first = `The passage was matched to this claim because of shared wording; ${verdictLine[verdict] ?? verdictLine.uncertain}${numberNote}${quoteNote}`;
  return { reasoning: first, suggested_fix: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(null, 200);

  try {
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    const body = await readJsonBody(req);
    const { claim, passage, verdict, code_checks } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (typeof claim !== "string" || typeof passage !== "string" || typeof verdict !== "string") {
      return json({ error: "Provide { claim, passage, verdict, code_checks }" }, 422);
    }
    if (claim.length > MAX_CLAIM_CHARS) return json({ error: "Claim is too long (max 2,000 characters)" }, 413);
    if (passage.length > MAX_PASSAGE_CHARS) return json({ error: "Passage is too long (max 2,000 characters)" }, 413);
    if (!VERDICTS.has(verdict)) return json({ error: "Unknown verdict" }, 422);
    const codeChecksJson = JSON.stringify(code_checks ?? {});
    if (codeChecksJson.length > MAX_CODE_CHECKS_CHARS) return json({ error: "code_checks is too large" }, 413);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ ...mockExplain(claim, passage, verdict, code_checks), mode: "mock" });
    }

    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
    const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Claim: ${claim}\n\nMatched passage: ${passage}\n\nVerdict: ${verdict}\n\nCode checks: ${codeChecksJson}` },
    ];

    // At most 2 attempts. Retry on unparseable output, 429/529 or a network error.
    // Every attempt is counted against the daily cap right before its OpenAI call.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await consumeDailyCall("explain");
      let content: string;
      try {
        content = await chatJson(apiKey, baseUrl, model, messages);
      } catch (e) {
        if (e instanceof UpstreamError && e.retryable && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
      try {
        const parsed = explainSchema.parse(JSON.parse(content));
        return json({ ...parsed, mode: "live", model });
      } catch (e) {
        console.error(`[explain] unparseable model output (attempt ${attempt + 1})`, e);
      }
    }
    return json({ error: "Explanation failed after retry" }, 502);
  } catch (err) {
    if (err instanceof HttpError) return json(err.payload, err.status);
    if (err instanceof UpstreamError) return json({ error: err.message }, 502);
    console.error("[explain] unexpected error", err);
    return json({ error: "explain failed" }, 500);
  }
});
