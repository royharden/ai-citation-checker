import { z } from "npm:zod@3.23.8";

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

async function chatJson(apiKey: string, baseUrl: string, model: string, messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("OpenAI rejected the API key (401)");
    if (res.status === 429) throw new Error("OpenAI rate limit reached (429)");
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI returned no message content");
  return content;
}

function mockExplain(claim: string, passage: string, verdict: string, codeChecks: unknown): { reasoning: string; suggested_fix: string | null } {
  const checks = (codeChecks as any) ?? {};
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
  const fix = verdict !== "supported" && passage ? null : null;
  return { reasoning: first, suggested_fix: fix };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(null, 200);

  try {
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    const body = await req.json().catch(() => null);
    const { claim, passage, verdict, code_checks } = body ?? {};
    if (typeof claim !== "string" || typeof passage !== "string" || typeof verdict !== "string") {
      return json({ error: "Provide { claim, passage, verdict, code_checks }" }, 422);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ ...mockExplain(claim, passage, verdict, code_checks), mode: "mock" });
    }

    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
    const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Claim: ${claim}\n\nMatched passage: ${passage}\n\nVerdict: ${verdict}\n\nCode checks: ${JSON.stringify(code_checks ?? {})}`,
      },
    ];

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await chatJson(apiKey, baseUrl, model, messages);
        const parsed = explainSchema.parse(JSON.parse(content));
        return json({ ...parsed, mode: "live", model });
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (lastError.message.startsWith("OpenAI")) throw lastError;
      }
    }
    return json({ error: `Explanation failed after retry: ${lastError?.message ?? "unknown"}` }, 502);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `explain failed: ${message}` }, 500);
  }
});
