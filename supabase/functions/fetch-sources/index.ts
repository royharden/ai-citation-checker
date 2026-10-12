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
const MAX_URLS = 5;
const MAX_URL_CHARS = 2_048;

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

// ---------- SSRF guard ----------
const REFUSED = "Refused: local, loopback, link-local, private, and metadata addresses are not allowed";

// Lowercase, drop IPv6 brackets and any trailing dots ("localhost." == "localhost")
function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.+$/, "");
}

function parseIPv4(h: string): number[] | null {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

// Returns the 8 16-bit groups, or null if this is not a valid IPv6 literal
function parseIPv6(input: string): number[] | null {
  let s = input;
  if (s.includes("%")) return null; // zone ids are never acceptable
  const lastColon = s.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    // embedded dotted IPv4, e.g. ::ffff:127.0.0.1
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (incl. 100.100.100.200 metadata)
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments (incl. 192.0.0.192 metadata), TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIPv6(g: number[]): boolean {
  const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d -> re-check as IPv4
  if (zeroPrefix(5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g[6], g[7]));
  if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(embeddedV4(g[6], g[7]));
  // NAT64 64:ff9b::a.b.c.d -> re-check as IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(embeddedV4(g[6], g[7]));
  // 6to4 2002:AABB:CCDD:: -> re-check the embedded IPv4
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g[1], g[2]));
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10 (fe80 - febf)
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7 (incl. fd00:ec2::254 metadata)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  // Everything else outside global unicast 2000::/3 is special-purpose:
  // ::, ::1, IPv4-compatible ::/96, 64:ff9b:1::/48, discard 100::/64, ...
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // IETF protocol assignments incl. Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation 3fff::/20
  return false;
}

// True if the address is a literal IP (v4 or v6), whatever its class
function isIpLiteral(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return parseIPv4(h) !== null || h.includes(":");
}

function isPrivateHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "internal" || h.endsWith(".internal")) return true; // incl. metadata.google.internal
  if (h.endsWith(".local") || h.endsWith(".localdomain") || h.endsWith(".home.arpa")) return true;
  if (h === "metadata" || h === "instance-data") return true; // cloud metadata short names
  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);
  if (h.includes(":")) {
    const v6 = parseIPv6(h);
    return v6 === null || isPrivateIPv6(v6);
  }
  return false;
}

// Thrown when a URL must not be fetched; the message is safe to return to the client
class FetchRefused extends Error {}

function checkUrl(rawUrl: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.toString().trim());
  } catch {
    throw new FetchRefused("Not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchRefused("Only http and https are allowed");
  }
  if (isPrivateHost(parsed.hostname)) throw new FetchRefused(REFUSED);
  return parsed;
}

const DNS_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNoRecords(e: unknown): boolean {
  return e instanceof Deno.errors.NotFound || (e instanceof Error && e.name === "NotFound");
}

// Resolve A and AAAA and refuse the host if any address is non-public. Fails closed on DNS errors.
async function assertPublicDns(hostname: string, signal: AbortSignal): Promise<void> {
  const h = normalizeHostname(hostname);
  if (isIpLiteral(h)) return; // literals were already classified by isPrivateHost
  if (typeof Deno.resolveDns !== "function") {
    console.error("[fetch-sources] Deno.resolveDns is unavailable; refusing fetch");
    throw new FetchRefused("Could not verify the host address");
  }
  const lookups = await Promise.allSettled([
    withTimeout(Deno.resolveDns(h, "A", { signal }), DNS_TIMEOUT_MS),
    withTimeout(Deno.resolveDns(h, "AAAA", { signal }), DNS_TIMEOUT_MS),
  ]);
  const addresses: string[] = [];
  for (const r of lookups) {
    if (r.status === "fulfilled") addresses.push(...r.value);
    else if (!isNoRecords(r.reason)) {
      console.error(`[fetch-sources] DNS lookup failed for ${h}`, r.reason);
      throw new FetchRefused("Could not resolve the host name");
    }
  }
  if (addresses.length === 0) throw new FetchRefused("Could not resolve the host name");
  if (addresses.some((ip) => isPrivateHost(ip))) throw new FetchRefused(REFUSED);
}

// ---------- Fetching ----------
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000; // whole fetch: DNS, every redirect hop and the body
const MAX_TITLE_CHARS = 300;

interface FetchResult { url: string; title: string | null; text: string; error: string | null }

// Stream the body with a size cap; every read also races the overall timeout
async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new FetchRefused("No response body");
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await Promise.race([reader.read(), aborted]);
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    const { done, value } = chunk;
    if (done) break;
    totalLen += value.byteLength;
    if (totalLen > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new FetchRefused("Page too large (over 2 MB)");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) { buf.set(c, pos); pos += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

async function fetchSource(raw: string): Promise<FetchResult> {
  const fail = (error: string): FetchResult => ({ url: raw, title: null, text: "", error });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = checkUrl(raw);
    const startHost = current.hostname;
    for (let hop = 0; ; hop++) {
      // Resolve and check the host before every request, including each redirect target
      await assertPublicDns(current.hostname, controller.signal);
      const res = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "CitationCheckerDemo/1.0 (+source fetcher)" },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new FetchRefused(`Redirect with no Location header (HTTP ${res.status})`);
        if (hop >= MAX_REDIRECTS) throw new FetchRefused(`Too many redirects (max ${MAX_REDIRECTS})`);
        let next: URL;
        try {
          next = new URL(location, current); // resolve relative redirects first
        } catch {
          throw new FetchRefused("Invalid redirect location");
        }
        current = checkUrl(next); // scheme + isPrivateHost on every Location
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new FetchRefused(`Fetch failed: HTTP ${res.status}`);
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("xml")) {
        await res.body?.cancel().catch(() => {});
        throw new FetchRefused(`Unsupported content type: ${contentType.split(";")[0].trim().slice(0, 100) || "unknown"}`);
      }
      const rawText = await readCapped(res, controller.signal);
      const text = contentType.includes("text/html") ? extractMainText(rawText) : rawText.trim();
      const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = (titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : startHost).slice(0, MAX_TITLE_CHARS);
      return { url: current.toString(), title, text, error: null };
    }
  } catch (e) {
    if (e instanceof FetchRefused) return fail(e.message);
    if (controller.signal.aborted) return fail("Timed out after 10 seconds");
    console.error(`[fetch-sources] fetch failed for ${raw}`, e);
    return fail("Could not fetch this URL");
  } finally {
    clearTimeout(timer);
  }
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
    const body = await readJsonBody(req);
    const urls = body && typeof body === "object" ? (body as Record<string, unknown>).urls : null;
    if (!Array.isArray(urls) || urls.length === 0) return json({ error: "Provide { urls: string[] }" }, 422);
    if (urls.length > MAX_URLS) return json({ error: `Maximum ${MAX_URLS} URLs per request` }, 422);
    if (urls.some((u) => typeof u === "string" && u.length > MAX_URL_CHARS)) {
      return json({ error: "URL is too long (max 2,048 characters)" }, 413);
    }

    const results = await Promise.all(urls.map((raw: unknown) => {
      if (typeof raw !== "string" || raw.trim() === "") {
        return { url: typeof raw === "string" ? raw : "", title: null, text: "", error: "Empty URL" };
      }
      return fetchSource(raw);
    }));

    return json({ results });
  } catch (err) {
    if (err instanceof HttpError) return json(err.payload, err.status);
    console.error("[fetch-sources] unexpected error", err);
    return json({ error: "fetch-sources failed" }, 500);
  }
});
