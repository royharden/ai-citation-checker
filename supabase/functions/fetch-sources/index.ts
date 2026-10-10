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

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv6 loopback / private
  if (h.includes(":")) {
    const clean = h.replace(/^\[|\]$/g, "");
    if (clean === "::1" || clean === "::" || clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80")) return true;
    return false;
  }
  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  // cloud metadata endpoints by name
  if (h === "metadata.google.internal" || h.endsWith(".compute.internal") || h === "169.254.169.254") return true;
  return false;
}

function isUrlAllowed(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http and https are allowed" };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: "Refused: local, loopback, link-local, private, and metadata addresses are not allowed" };
  }
  return { ok: true, url: parsed };
}

const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithRedirects(startUrl: URL): Promise<{ response: Response; finalUrl: string } | { error: string }> {
  let currentUrl = startUrl;
  let lastResponse: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = isUrlAllowed(currentUrl.toString());
    if (!check.ok) return { error: check.reason };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(currentUrl.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "CitationCheckerDemo/1.0 (+source fetcher)" },
      });

      // Manual redirect handling (3xx)
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { error: `Redirect with no Location header (HTTP ${res.status})` };
        // Resolve relative URLs against the current URL
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          return { error: `Invalid redirect Location: ${location}` };
        }
        currentUrl = nextUrl;
        continue; // re-check isPrivateHost on next iteration
      }

      lastResponse = res;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg.includes("abort") ? "Timed out after 10 seconds" : `Fetch failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  if (!lastResponse) {
    return { error: `Too many redirects (max ${MAX_REDIRECTS})` };
  }
  return { response: lastResponse, finalUrl: currentUrl.toString() };
}

function extractMainText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(h1|h2|h3|h4|h5|h6|p|div|section|article|li|blockquote|br|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(null, 200);

  try {
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    const body = await req.json().catch(() => null);
    const urls: unknown = body?.urls;
    if (!Array.isArray(urls) || urls.length === 0) return json({ error: "Provide { urls: string[] }" }, 422);
    if (urls.length > 5) return json({ error: "Maximum 5 URLs per request" }, 422);

    const results = await Promise.all(urls.map(async (raw: unknown) => {
      const fail = (error: string) => ({ url: typeof raw === "string" ? raw : "", title: null, text: "", error });
      if (typeof raw !== "string" || raw.trim() === "") return fail("Empty URL");

      const initialCheck = isUrlAllowed(raw);
      if (!initialCheck.ok) return fail(initialCheck.reason);

      const fetchResult = await fetchWithRedirects(initialCheck.url);
      if ("error" in fetchResult) return fail(fetchResult.error);

      const res = fetchResult.response;
      if (!res.ok) return fail(`Fetch failed: HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("xml")) {
        return fail(`Unsupported content type: ${contentType || "unknown"}`);
      }

    // Stream-cap: read up to MAX_BYTES + 1 to detect overflow
    const reader = res.body?.getReader();
    if (!reader) return fail("No response body");
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    let oversized = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLen += value.byteLength;
      if (totalLen > MAX_BYTES) { oversized = true; break; }
      chunks.push(value);
    }
    if (oversized) return fail("Page too large (over 2 MB)");

    const buf = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) { buf.set(c, pos); pos += c.byteLength; }
    const rawText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const text = contentType.includes("text/html") ? extractMainText(rawText) : rawText.trim();
      const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : initialCheck.url.hostname;
      return { url: fetchResult.finalUrl, title, text, error: null };
    }));

    return json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `fetch-sources failed: ${message}` }, 500);
  }
});
