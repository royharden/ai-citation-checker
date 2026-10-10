import type { Passage, RawClaim, Source, CodeChecks, QuoteCheck, NumberCheck, CitationCheck, Verdict, VerdictWeights } from "./types";

// ---------- normalization ----------
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text).split(/[^a-z0-9%€$]+/).filter(Boolean);
}

// ---------- quoteCheck ----------
export function quoteCheck(quote: string | null, passage: string | null): QuoteCheck | null {
  if (!quote || !passage) return null;
  const nQuote = normalize(quote);
  const nPassage = normalize(passage);
  if (nPassage.includes(nQuote)) {
    return { status: "exact", similarity: 100, outOfContextFlag: false };
  }
  const sim = tokenLcs(tokens(quote), tokens(passage));
  if (sim >= 60) {
    return { status: "close", similarity: sim, outOfContextFlag: false };
  }
  return { status: "not_found", similarity: sim, outOfContextFlag: false };
}

export function tokenLcs(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = b;
  let matches = 0;
  // longest common subsequence (DP)
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  matches = dp[a.length][b.length];
  return Math.round((2 * matches) / (a.length + b.length) * 100);
}

// ---------- numberCheck ----------
const NUM_RE = /(\d[\d.,]*)\s?(%|percent|km|million|billion|mg\/l|euros?|dollars?|minutes?|weeks?|years?)?/gi;

function extractNumbers(text: string): { value: number; display: string }[] {
  const out: { value: number; display: string }[] = [];
  const s = normalize(text);
  let m: RegExpExecArray | null;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s)) !== null) {
    const numStr = m[1].replace(/,(?=\d{3})/g, "");
    const value = parseFloat(numStr);
    if (Number.isNaN(value)) continue;
    out.push({ value, display: (m[2] ? `${m[1]} ${m[2]}` : m[1]) });
  }
  return out;
}

export function numberCheck(claim: string, passage: string | null): NumberCheck | null {
  if (!passage) return null;
  const claimNums = extractNumbers(claim);
  if (claimNums.length === 0) return null;
  const passageNums = extractNumbers(passage);
  const passageVals = passageNums.map((n) => n.value);
  for (const cn of claimNums) {
    const found = passageNums.find((pn) => Math.abs(pn.value - cn.value) < 0.001);
    if (!found) {
      // find the closest passage number for the message
      const closest = passageNums.reduce<(typeof passageNums)[number] | null>((best, pn) => {
        if (!best) return pn;
        return Math.abs(pn.value - cn.value) < Math.abs(best.value - cn.value) ? pn : best;
      }, null);
      return {
        mismatch: true,
        claim_value: cn.display,
        passage_value: closest ? closest.display : null,
        detail: `Number mismatch: ${cn.display}${closest ? ` vs ${closest.display}` : " not found in passage"}`,
      };
    }
  }
  // all claim numbers found; check years specifically
  return { mismatch: false, claim_value: null, passage_value: null, detail: null };
}

// ---------- citationCheck ----------
export function citationCheck(claim: RawClaim, matched: Passage | null): CitationCheck | null {
  if (!claim.cited_source) return null;
  const marker = claim.cited_source.trim();
  const bracket = marker.match(/\[(\d+)\]/);
  if (bracket) {
    const idx = Number(bracket[1]);
    if (matched && matched.sourceLabel !== `[${idx}]`) {
      // does a source with that label exist?
      return {
        wrongSource: true,
        citationNotFound: false,
        detail: `Wrong source cited: [${idx}] but passage matched from ${matched.sourceLabel}`,
      };
    }
  }
  return { wrongSource: false, citationNotFound: false, detail: null };
}

export function citationNotFoundCheck(claim: RawClaim, sources: Source[]): CitationCheck | null {
  if (!claim.cited_source) return null;
  const bracket = claim.cited_source.match(/\[(\d+)\]/);
  if (bracket) {
    const label = `[${bracket[1]}]`;
    if (!sources.some((s) => s.label === label)) {
      return { wrongSource: false, citationNotFound: true, detail: `Citation not found: ${label} is not among the provided sources` };
    }
  }
  return null;
}

// ---------- assemble ----------
export function runCodeChecks(claim: RawClaim, matched: Passage | null, sources: Source[]): CodeChecks {
  const quote = claim.kind === "quote" ? quoteCheck(claim.quote_text, matched?.text ?? null) : null;
  const number = numberCheck(claim.text, matched?.text ?? null);
  const notFound = citationNotFoundCheck(claim, sources);
  const wrongSource = notFound ? null : citationCheck(claim, matched);
  const citation = notFound ?? wrongSource;

  const chips: string[] = [];
  if (quote?.status === "exact") chips.push("Exact quote");
  if (quote?.status === "close") chips.push(`Close paraphrase (${quote.similarity}%)`);
  if (quote?.status === "not_found") chips.push("Quote not found");
  if (quote && quote.status !== "exact") {
    // Code says exact but Jev says misquoted handled at report assembly
  }
  if (number?.mismatch) chips.push(number.detail!);
  if (citation?.citationNotFound) chips.push("Citation not found");
  if (citation?.wrongSource) chips.push("Wrong source cited");

  return { quote, number, citation, chips };
}

// ---------- verdict adjustment ----------
const ORDER: Verdict[] = ["supported", "partially_supported", "unsupported", "contradicted", "misquoted", "uncertain"];
const CAP_INDEX: Record<string, number> = { supported: 0, partially_supported: 1 };

export function adjustVerdict(jevChoice: Verdict, checks: CodeChecks, anySupport: number, weakMatch: boolean): Verdict {
  let verdict = jevChoice;
  // best_passage none with any_support below 0.3 means unsupported
  if (weakMatch && anySupport < 0.3 && (verdict === "supported" || verdict === "partially_supported")) {
    verdict = "unsupported";
  }
  // number mismatch caps at partially_supported
  if (checks.number?.mismatch && ORDER.indexOf(verdict) <= ORDER.indexOf("partially_supported") && verdict !== "contradicted" && verdict !== "misquoted") {
    verdict = "partially_supported";
  }
  return verdict;
}

// ---------- trust score ----------
export function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function trustScore(
  claims: { verdict: Verdict; probabilities: Record<string, number> | null; kind: string }[],
  weights: VerdictWeights = { supported: 1.0, partially_supported: 0.6, uncertain: 0.4, unsupported: 0.1, contradicted: 0.0, misquoted: 0.0 }
): { score: number; grade: string } {
  if (claims.length === 0) return { score: 0, grade: "F" };
  let weightedSum = 0;
  let totalWeight = 0;
  let hasBad = false;
  for (const c of claims) {
    let ev: number;
    if (c.probabilities && Object.keys(c.probabilities).length > 0) {
      ev = Object.entries(c.probabilities).reduce((sum, [k, p]) => sum + p * (weights[k as Verdict] ?? 0), 0);
    } else {
      ev = weights[c.verdict] ?? 0;
    }
    const w = c.kind === "quote" ? 1.5 : 1;
    weightedSum += ev * w;
    totalWeight += w;
    if (c.verdict === "contradicted" || c.verdict === "misquoted") hasBad = true;
  }
  let score = (100 * weightedSum) / totalWeight;
  if (hasBad) score = Math.min(score, 59); // cap grade at C
  return { score: Math.round(score * 10) / 10, grade: gradeFor(score) };
}
