import { invokeFn, supabase, supabaseConfigured } from "./supabaseClient";
import type { RawClaim, Source, JevVerifyResult, Verdict, ClaimReport, CheckReport, Passage, CodeChecks } from "./types";
import { runCodeChecks, adjustVerdict, trustScore } from "./checks";

export function findCharSpan(answer: string, text: string): { start: number; end: number } | null {
  const direct = answer.indexOf(text);
  if (direct !== -1) return { start: direct, end: direct + text.length };
  // whitespace-insensitive fallback
  const target = text.replace(/\s+/g, "");
  if (!target) return null;
  const sq = answer.replace(/\s+/g, "");
  const idx = sq.indexOf(target);
  if (idx === -1) return null;
  const map: number[] = [];
  for (let i = 0; i < answer.length; i++) {
    if (!/\s/.test(answer[i])) map.push(i);
  }
  const start = map[idx];
  const end = map[idx + target.length - 1];
  if (start === undefined || end === undefined) return null;
  return { start, end: end + 1 };
}

export function labelSources(sources: Source[]): Source[] {
  return sources.map((s, i) => ({ ...s, label: s.label || `[${i + 1}]` }));
}

const LLM_JUDGE_INPUT = 2.5 / 1_000_000; // $2.50/M input
const LLM_JUDGE_OUTPUT = 10 / 1_000_000; // $10/M output
const LLM_JUDGE_OUTPUT_TOKENS = 150;
const LLM_JUDGE_INPUT_TOKENS = 1200;

export function estimateLlmJudgeCost(numClaims: number): number {
  return numClaims * (LLM_JUDGE_INPUT_TOKENS * LLM_JUDGE_INPUT + LLM_JUDGE_OUTPUT_TOKENS * LLM_JUDGE_OUTPUT);
}

// ---- Local fallbacks (used when Supabase is not configured) ----
function mockSplit(answer: string): RawClaim[] {
  const claims: RawClaim[] = [];
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

const VERDICT_LINE: Record<string, string> = {
  supported: "The passage states the facts in this claim.",
  partially_supported: "The passage backs up part of the claim, but some detail is missing or overstated.",
  unsupported: "The passage does not mention what the claim says.",
  contradicted: "The passage says the opposite of the claim.",
  misquoted: "The quotation does not match the words or meaning in the passage.",
  uncertain: "There is not enough information in the passage to decide.",
};

function mockReasoning(verdict: Verdict, checks: CodeChecks): string {
  const numberNote = checks.number?.mismatch
    ? ` The passage reports ${checks.number.passage_value} where the claim says ${checks.number.claim_value}.`
    : "";
  const quoteNote = checks.quote?.status === "exact"
    ? " The quoted words appear in the passage."
    : checks.quote?.status === "close"
      ? ` The quote is a close paraphrase (${checks.quote.similarity}%) rather than exact.`
      : "";
  return `The passage was matched to this claim because of shared wording; ${VERDICT_LINE[verdict] ?? VERDICT_LINE.uncertain}${numberNote}${quoteNote}`;
}

export interface RunOptions {
  answer: string;
  sources: Source[];
  title: string;
  demoSlug: string | null;
  recordedJev: Record<string, unknown> | null;
  onStage: (stage: string, info: Record<string, unknown>) => void;
}

export async function runCheck(opts: RunOptions): Promise<CheckReport> {
  const { answer, sources, onStage } = opts;
  const labeled = labelSources(sources);

  // ---- Stage: extract claims ----
  onStage("extract", { status: "running" });
  const extractStart = Date.now();
  let extractRes: { claims: RawClaim[]; mode: "live" | "mock"; note?: string };
  if (supabaseConfigured) {
    try {
      extractRes = await invokeFn<{ claims: RawClaim[]; mode: "live" | "mock"; note?: string }>("extract-claims", { answer });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onStage("notice", { message: `${msg} — using built-in claim splitter` });
      extractRes = { claims: mockSplit(answer), mode: "mock", note: undefined };
    }
  } else {
    onStage("notice", { message: "Supabase not configured — using built-in claim splitter (Mock mode)" });
    extractRes = { claims: mockSplit(answer), mode: "mock", note: undefined };
  }
  const extractMs = Date.now() - extractStart;
  const llmMode: "live" | "mock" = extractRes.mode === "live" ? "live" : "mock";
  if (extractRes.note) onStage("notice", { message: extractRes.note });
  onStage("extract", { status: "done", ms: extractMs, count: extractRes.claims.length, mode: llmMode });

  const withSpans = extractRes.claims.map((c, idx) => {
    const span = findCharSpan(answer, c.text);
    return { ...c, idx, char_start: span?.start ?? null, char_end: span?.end ?? null };
  });

  // ---- Stage: passage match + Jev verify ----
  onStage("passages", { status: "running" });
  let jevResults: JevVerifyResult[] = [];
  let jevMode: "live" | "replay" = "live";
  let verifyError: string | null = null;

  const jevStart = Date.now();
  if (supabaseConfigured) {
    try {
      const res = await invokeFn<{ results: JevVerifyResult[] }>("jev-verify", {
        claims: withSpans.map((c) => ({ id: c.id, kind: c.kind, text: c.text, quote_text: c.quote_text, cited_source: c.cited_source })),
        sources: labeled.map((s) => ({ label: s.label, title: s.title, content: s.content })),
      });
      jevResults = res.results;
      onStage("jev", { status: "done", ms: Date.now() - jevStart, calls: jevResults.length * 2 });
    } catch (e) {
      verifyError = e instanceof Error ? e.message : String(e);
      const isDailyLimit = verifyError === "daily_limit";
      const hasRecorded = !!opts.recordedJev && Object.keys(opts.recordedJev).length > 0;
      if (isDailyLimit && hasRecorded) {
        jevMode = "replay";
        onStage("notice", { message: "Daily demo limit reached — switching to Replay mode" });
        verifyError = null;
      } else if (isDailyLimit) {
        onStage("notice", { message: "Daily demo limit reached — live Jev calls are capped at 200 per day" });
        verifyError = null;
        jevMode = "replay";
      }
    }
  } else {
    onStage("notice", { message: "Supabase not configured — using recorded Jev answers (Replay mode)" });
    jevMode = "replay";
  }

  if (verifyError) {
    const hasRecorded = !!opts.recordedJev && Object.keys(opts.recordedJev).length > 0;
    if (hasRecorded) {
      jevMode = "replay";
      onStage("notice", { message: `${verifyError} — using recorded Jev answers (Replay mode)` });
    } else {
      throw new Error(verifyError);
    }
  }

  // ---- Assemble per-claim reports ----
  const claims: ClaimReport[] = withSpans.map((c, i) => {
    const jev = jevResults.find((r) => r.claim_id === c.id);
    let matched: Passage | null = null;
    let candidates: Passage[] = [];
    let choice: Verdict = "unsupported";
    let confidence: number | null = null;
    let probabilities: Record<string, number> | null = null;
    let anySupport = 0;
    let weakMatch = false;    let request: unknown = null;
    let response: unknown = null;
    let model: string | null = null;
    let latencyMs: number | null = null;
    let inputTokens: number | null = null;
    let costUsd: number | null = null;
    let injectionNoul: number | null = null;

    if (jevMode === "replay" && opts.recordedJev) {
      const rec = opts.recordedJev[`claim_${i}`] as Record<string, any> | undefined;
      if (rec) {
        choice = rec?.stage2?.verdict?.choice ?? "uncertain";
        confidence = rec?.stage2?.verdict?.confidence ?? null;
        probabilities = rec?.stage2?.verdict?.probabilities ?? null;
        anySupport = rec?.stage1?.any_support?.noul ?? 0;
        injectionNoul = rec?.stage2?.injection?.noul ?? null;
        request = { stage1: rec?.stage1 ?? null, stage2: rec?.stage2 ?? null };
        response = { replay: true, note: "Recorded Jev answers (Replay fixture) — not a live call" };
        model = "jev-1.13.0 (recorded)";
      }
    } else if (jev) {
      choice = jev.choice;
      confidence = jev.confidence;
      probabilities = jev.probabilities;
      anySupport = jev.stage1.any_support ?? 0;
      weakMatch = jev.stage2.weak_match;
      matched = jev.matched_passage ?? null;
      candidates = jev.candidate_passages ?? [];
      request = { stage1: jev.stage1.request, stage2: jev.stage2.request };
      response = { stage1: jev.stage1.response, stage2: jev.stage2.response };
      model = jev.model;
      latencyMs = jev.latency_ms;
      inputTokens = jev.usage.input_tokens;
      costUsd = jev.cost_usd;
      injectionNoul = jev.injection_noul;
    }

    const codeChecks = runCodeChecks(c, matched, labeled);
    const verdict = adjustVerdict(choice, codeChecks, anySupport, weakMatch);
    const flags: string[] = [];
    if (codeChecks.quote?.status === "exact" && choice === "misquoted") flags.push("Out of context?");
    if (choice === "uncertain" || (confidence !== null && confidence < 0.6)) flags.push("Needs review");

    return {
      id: c.id,
      idx: c.idx,
      kind: c.kind,
      text: c.text,
      quote_text: c.quote_text,
      char_start: c.char_start,
      char_end: c.char_end,
      cited_source: c.cited_source,
      candidates,
      matched,
      jev_request: request,
      jev_response: response,
      model,
      verdict,
      probabilities,
      confidence,
      code_checks: codeChecks,
      flags,
      reasoning: null,
      suggested_fix: null,
      latency_ms: latencyMs,
      input_tokens: inputTokens,
      cost_usd: costUsd,
    };
  });

  // ---- Mark sources suspicious from injection noul ----
  const claimInjections: { label: string; noul: number }[] = [];
  for (const c of claims) {
    const jev = jevResults.find((r) => r.claim_id === c.id);
    if (jev?.matched_passage && jev.injection_noul !== null) {
      claimInjections.push({ label: jev.matched_passage.sourceLabel, noul: jev.injection_noul });
    }
    if (jevMode === "replay" && opts.recordedJev) {
      const rec = opts.recordedJev[`claim_${c.idx}`] as Record<string, any> | undefined;
      const noul = rec?.stage2?.injection?.noul;
      if (typeof noul === "number" && noul >= 0.5) {
        // map to the source the claim cites
        const cited = c.cited_source;
        if (cited) claimInjections.push({ label: cited, noul });
      }
    }
  }
  const finalSources = labeled.map((s) => ({
    ...s,
    suspicious: s.suspicious || claimInjections.some((ci) => ci.label === s.label && ci.noul >= 0.5),
  }));

  // ---- Excluded-source effect: claims relying only on a suspicious source aren't supported ----
  for (const c of claims) {
    const isOnlySuspicious =
      c.matched === null &&
      c.cited_source !== null &&
      finalSources.find((s) => s.label === c.cited_source)?.suspicious === true;
    if (isOnlySuspicious && (c.verdict === "supported" || c.verdict === "partially_supported")) {
      c.verdict = "uncertain";
      c.flags = [...c.flags, "Source excluded: instructions to AI"];
    }
  }

  // ---- Explain (LLM or mock) ----
  onStage("explain", { status: "running", count: claims.length });
  const explainStart = Date.now();
  await Promise.all(
    claims.map(async (c) => {
      if (!supabaseConfigured) {
        c.reasoning = mockReasoning(c.verdict, c.code_checks);
        return;
      }
      try {
        const res = await invokeFn<{ reasoning: string; suggested_fix: string | null; mode: "live" | "mock" }>("explain", {
          claim: c.text,
          passage: c.matched?.text ?? "(no passage matched)",
          verdict: c.verdict,
          code_checks: c.code_checks,
        });
        c.reasoning = res.reasoning;
        c.suggested_fix = res.suggested_fix;
      } catch {
        c.reasoning = mockReasoning(c.verdict, c.code_checks);
      }
    })
  );
  onStage("explain", { status: "done", ms: Date.now() - explainStart });

  // ---- Trust score + summary ----
  const score = trustScore(claims.map((c) => ({ verdict: c.verdict, probabilities: c.probabilities, kind: c.kind })));
  const verdictCounts: Record<string, number> = {};
  for (const c of claims) verdictCounts[c.verdict] = (verdictCounts[c.verdict] ?? 0) + 1;
  const latencies = claims.map((c) => c.latency_ms ?? 0).filter((l) => l > 0).sort((a, b) => a - b);
  const totalCalls = claims.length * 2;
  const avgLatency = latencies.length ? latencies.reduce((s, l) => s + l, 0) / latencies.length : 0;
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
  const jevCost = claims.reduce((s, c) => s + (c.cost_usd ?? 0), 0);

  return {
    id: "",
    title: opts.title,
    answerText: answer,
    demoSlug: opts.demoSlug,
    llmMode,
    jevMode,
    trustScore: score.score,
    grade: score.grade,
    claims,
    sources: finalSources,
    summary: {
      verdictCounts: verdictCounts as CheckReport["summary"]["verdictCounts"],
      totalCalls,
      avgLatencyMs: Math.round(avgLatency),
      p95LatencyMs: Math.round(p95),
      jevCostUsd: jevCost,
      llmJudgeCostUsd: estimateLlmJudgeCost(claims.length),
    },
    createdAt: new Date().toISOString(),
  };
}

// ---- Persistence ----
export async function saveCheck(report: CheckReport): Promise<string> {
  if (!supabaseConfigured) return "";
  const { data: checkRow, error: checkErr } = await supabase
    .from("checks")
    .insert({
      title: report.title,
      answer_text: report.answerText,
      demo_slug: report.demoSlug,
      llm_mode: report.llmMode,
      jev_mode: report.jevMode,
      trust_score: report.trustScore,
      grade: report.grade,
      summary: report.summary as unknown as Record<string, unknown>,
      jev_cost_usd: report.summary.jevCostUsd,
    })
    .select("id")
    .single();
  if (checkErr) throw checkErr;

  const checkId = checkRow.id as string;

  if (report.sources.length) {
    const { error } = await supabase.from("sources").insert(
      report.sources.map((s) => ({
        check_id: checkId,
        label: s.label,
        kind: s.kind,
        url: s.url,
        title: s.title,
        content: s.content,
        fetch_error: s.fetch_error,
        suspicious: s.suspicious,
      }))
    );
    if (error) throw error;
  }

  if (report.claims.length) {
    const { error } = await supabase.from("claims").insert(
      report.claims.map((c) => ({
        check_id: checkId,
        idx: c.idx,
        kind: c.kind,
        text: c.text,
        quote_text: c.quote_text,
        char_start: c.char_start,
        char_end: c.char_end,
        cited_source: c.cited_source,
        candidate_passages: c.candidates as unknown as Record<string, unknown>,
        matched_passage: c.matched as unknown as Record<string, unknown> | null,
        jev_request: (c.jev_request ?? {}) as Record<string, unknown>,
        jev_response: (c.jev_response ?? {}) as Record<string, unknown>,
        model: c.model,
        verdict: c.verdict,
        probabilities: (c.probabilities ?? {}) as Record<string, unknown>,
        confidence: c.confidence,
        code_checks: c.code_checks as unknown as Record<string, unknown>,
        flags: c.flags,
        reasoning: c.reasoning,
        suggested_fix: c.suggested_fix,
        latency_ms: c.latency_ms,
        input_tokens: c.input_tokens,
        cost_usd: c.cost_usd,
      }))
    );
    if (error) throw error;
  }

  return checkId;
}

export async function loadCheck(id: string): Promise<CheckReport | null> {
  if (!supabaseConfigured) return null;
  const [{ data: check }, { data: sources }, { data: claims }] = await Promise.all([
    supabase.from("checks").select("*").eq("id", id).maybeSingle(),
    supabase.from("sources").select("*").eq("check_id", id),
    supabase.from("claims").select("*").eq("check_id", id).order("idx"),
  ]);
  if (!check) return null;

  const claimReports: ClaimReport[] = (claims ?? []).map((c: Record<string, any>) => ({
    id: c.id,
    idx: c.idx,
    kind: c.kind,
    text: c.text,
    quote_text: c.quote_text,
    char_start: c.char_start,
    char_end: c.char_end,
    cited_source: c.cited_source,
    candidates: c.candidate_passages ?? [],
    matched: c.matched_passage ?? null,
    jev_request: c.jev_request ?? null,
    jev_response: c.jev_response ?? null,
    model: c.model,
    verdict: c.verdict,
    probabilities: c.probabilities && Object.keys(c.probabilities).length ? c.probabilities : null,
    confidence: c.confidence,
    code_checks: c.code_checks ?? { quote: null, number: null, citation: null, chips: [] },
    flags: c.flags ?? [],
    reasoning: c.reasoning,
    suggested_fix: c.suggested_fix,
    latency_ms: c.latency_ms,
    input_tokens: c.input_tokens,
    cost_usd: c.cost_usd,
  }));

  return {
    id: check.id,
    title: check.title,
    answerText: check.answer_text,
    demoSlug: check.demo_slug,
    llmMode: check.llm_mode,
    jevMode: check.jev_mode,
    trustScore: check.trust_score ?? 0,
    grade: check.grade ?? "F",
    claims: claimReports,
    sources: (sources ?? []).map((s: Record<string, any>) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      url: s.url,
      title: s.title,
      content: s.content,
      fetch_error: s.fetch_error,
      suspicious: s.suspicious,
    })),
    summary: check.summary as CheckReport["summary"],
    createdAt: check.created_at,
  };
}

export async function listPastChecks(): Promise<{ id: string; title: string; trust_score: number | null; grade: string | null; created_at: string }[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from("checks")
    .select("id, title, trust_score, grade, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}
