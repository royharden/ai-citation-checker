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
const MAX_ANSWER_CHARS = 20_000;

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

const claimSchema = z.object({
  id: z.string(),
  kind: z.enum(["claim", "quote"]),
  text: z.string().min(1),
  quote_text: z.string().nullable().optional(),
  cited_source: z.string().nullable().optional(),
});
export type ClaimOut = z.infer<typeof claimSchema>;

const responseSchema = z.object({ claims: z.array(claimSchema).max(40) });

const SYSTEM_PROMPT = `You split AI-generated answers into atomic, checkable units for a citation checker.

Rules:
- One atomic, checkable statement per claim. No compound claims.
- "text" MUST be an exact substring of the answer (copy it verbatim).
- kind: "quote" for words inside quotation marks attributed to someone; "claim" otherwise.
- For quotes, quote_text is the quoted words WITHOUT the quotation marks.
- cited_source is the citation marker used in the answer, e.g. "[1]", "(https://...)" or "Agency report". null if none.
- Skip opinions, filler, questions, and greetings.
- Maximum 40 claims. Return JSON: {"claims": [{"id": "claim_0", ...}]}.`;

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
    console.error("[extract-claims] OpenAI fetch failed", e);
    if (controller.signal.aborted) throw new UpstreamError("OpenAI request timed out", false);
    throw new UpstreamError("Could not reach OpenAI", true);
  }
  try {
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[extract-claims] OpenAI returned ${res.status}: ${detail.slice(0, 500)}`);
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

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Could not parse JSON from model output");
  }
}

function mockSplit(answer: string): ClaimOut[] {
  const claims: ClaimOut[] = [];
  const sentences = answer.match(/[^.!?]+[.!?]+["')\]]*|\S+$/g) ?? [answer];
  let i = 0;
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length < 8) continue;
    const quoted = sentence.match(/"([^"]{3,})"/g);
    if (quoted) {
      for (const q of quoted) {
        const inner = q.slice(1, -1);
        const marker = sentence.match(/\[\d+\]|https?:\/\/\S+|\([^)]*\)/)?.[0] ?? null;
        claims.push({ id: `claim_${i}`, kind: "quote", text: sentence, quote_text: inner, cited_source: marker });
        i++;
      }
    }
    if (/^(i think|i feel|maybe|perhaps|hello|thanks)/i.test(sentence)) continue;
    const marker = sentence.match(/\[\d+\]|https?:\/\/\S+/)?.[0] ?? null;
    claims.push({ id: `claim_${i}`, kind: "claim", text: sentence, quote_text: null, cited_source: marker });
    i++;
    if (i >= 40) break;
  }
  return claims;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(null, 200);

  try {
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    const body = await readJsonBody(req);
    const answer = body && typeof body === "object" ? (body as Record<string, unknown>).answer : null;
    if (typeof answer !== "string" || answer.trim() === "") {
      return json({ error: "Provide { answer: string }" }, 422);
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      return json({ error: "Answer is too long (max 20,000 characters)" }, 413);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ claims: mockSplit(answer), mode: "mock", note: "OPENAI_API_KEY not set — used rule-based claim splitter" });
    }

    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
    const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Answer:\n\n${answer}` },
    ];

    // At most 2 attempts. Retry on unparseable output, 429/529 or a network error.
    // Every attempt is counted against the daily cap right before its OpenAI call.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await consumeDailyCall("extract-claims");
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
        const parsed = responseSchema.parse(extractJson(content));
        return json({ claims: parsed.claims, mode: "live", model });
      } catch (e) {
        console.error(`[extract-claims] unparseable model output (attempt ${attempt + 1})`, e);
      }
    }
    return json({ error: "Claim extraction failed after retry" }, 502);
  } catch (err) {
    if (err instanceof HttpError) return json(err.payload, err.status);
    if (err instanceof UpstreamError) return json({ error: err.message }, 502);
    console.error("[extract-claims] unexpected error", err);
    return json({ error: "extract-claims failed" }, 500);
  }
});
