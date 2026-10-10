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

// ---- OpenAI call (no temperature, ever) ----
async function chatJson(apiKey: string, baseUrl: string, model: string, messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("OpenAI rejected the API key (401)");
    if (res.status === 429) throw new Error("OpenAI rate limit reached (429)");
    throw new Error(`OpenAI request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI returned no message content");
  return content;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // tolerate fenced or prefixed JSON
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Could not parse JSON from model output");
  }
}

// ---- Mock splitter ----
function mockSplit(answer: string): ClaimOut[] {
  const claims: ClaimOut[] = [];
  // Split into sentences on '. ', '! ', '? ' keeping terminators.
  const sentences = answer.match(/[^.!?]+[.!?]+["')\]]*|\S+$/g) ?? [answer];
  let i = 0;
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length < 8) continue;
    // quotes inside the sentence
    const quoted = sentence.match(/"([^"]{3,})"/g);
    if (quoted) {
      for (const q of quoted) {
        const inner = q.slice(1, -1);
        const marker = sentence.match(/\[\d+\]|https?:\/\/\S+|\([^)]*\)/)?.[0] ?? null;
        claims.push({
          id: `claim_${i}`,
          kind: "quote",
          text: sentence,
          quote_text: inner,
          cited_source: marker,
        });
        i++;
      }
    }
    // skip pure opinions / short interjections
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
    const { answer } = await req.json().catch(() => ({ answer: null }));
    if (typeof answer !== "string" || answer.trim() === "") {
      return json({ error: "Provide { answer: string }" }, 422);
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

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await chatJson(apiKey, baseUrl, model, messages);
        const parsed = responseSchema.parse(extractJson(content));
        return json({ claims: parsed.claims, mode: "live", model });
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Only retry on parse/validation failure; surface API errors immediately
        if (lastError.message.startsWith("OpenAI")) throw lastError;
      }
    }
    return json({ error: `Claim extraction failed after retry: ${lastError?.message ?? "unknown"}` }, 502);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `extract-claims failed: ${message}` }, 500);
  }
});
