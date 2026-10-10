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
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  // metadata endpoints by name
  if (h === "metadata.google.internal" || h.endsWith(".compute.internal")) return true;
  return false;
}

function extractMainText(html: string): string {
  let text = html;
  // Drop script/style/nav/footer/svg blocks
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
      let parsed: URL;
      try {
        parsed = new URL(raw.trim());
      } catch {
        return fail("Not a valid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail("Only http and https are allowed");
      if (isPrivateHost(parsed.hostname)) return fail("Refused: local and private addresses are not allowed");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(parsed.toString(), {
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": "CitationCheckerDemo/1.0 (+source fetcher)" },
        });
        if (!res.ok) return fail(`Fetch failed: HTTP ${res.status}`);
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("xml")) {
          return fail(`Unsupported content type: ${contentType || "unknown"}`);
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 2 * 1024 * 1024) return fail("Page too large (over 2 MB)");
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        const text = contentType.includes("text/html") ? extractMainText(raw) : raw.trim();
        const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : parsed.hostname;
        return { url: parsed.toString(), title, text, error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(msg.includes("abort") ? "Timed out after 10 seconds" : `Fetch failed: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    }));

    return json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `fetch-sources failed: ${message}` }, 500);
  }
});
