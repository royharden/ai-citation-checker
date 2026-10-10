export type Verdict =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "contradicted"
  | "misquoted"
  | "uncertain";

export type ClaimKind = "claim" | "quote";

export interface RawClaim {
  id: string;
  kind: ClaimKind;
  text: string;
  quote_text: string | null;
  cited_source: string | null;
}

export interface Passage {
  id: string;
  text: string;
  sourceLabel: string;
  sourceTitle: string | null;
}

export interface QuoteCheck {
  status: "exact" | "close" | "not_found";
  similarity: number;
  outOfContextFlag: boolean;
}

export interface NumberCheck {
  mismatch: boolean;
  claim_value: string | null;
  passage_value: string | null;
  detail: string | null;
}

export interface CitationCheck {
  wrongSource: boolean;
  citationNotFound: boolean;
  detail: string | null;
}

export interface CodeChecks {
  quote: QuoteCheck | null;
  number: NumberCheck | null;
  citation: CitationCheck | null;
  chips: string[];
}

export interface JevVerifyResult {
  claim_id: string;
  stage1: { request: unknown; response: unknown; best_passage_id: string | null; any_support: number };
  stage2: { request: unknown; response: unknown; weak_match: boolean };
  matched_passage: Passage | null;
  candidate_passages: Passage[];
  model: string;
  choice: Verdict;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  injection_noul: number | null;
  quote_exact_noul: number | null;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  cost_usd: number;
}

export interface Source {
  id: string;
  label: string;
  kind: "text" | "url";
  url: string | null;
  title: string | null;
  content: string;
  fetch_error: string | null;
  suspicious: boolean;
}

export interface ClaimReport {
  id: string;
  idx: number;
  kind: ClaimKind;
  text: string;
  quote_text: string | null;
  char_start: number | null;
  char_end: number | null;
  cited_source: string | null;
  candidates: Passage[];
  matched: Passage | null;
  jev_request: unknown;
  jev_response: unknown;
  model: string | null;
  verdict: Verdict;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  code_checks: CodeChecks;
  flags: string[];
  reasoning: string | null;
  suggested_fix: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  cost_usd: number | null;
}

export interface VerdictWeights {
  supported: number;
  partially_supported: number;
  unsupported: number;
  contradicted: number;
  misquoted: number;
  uncertain: number;
}

export interface CheckReport {
  id: string;
  title: string;
  answerText: string;
  demoSlug: string | null;
  llmMode: "live" | "mock";
  jevMode: "live" | "replay";
  trustScore: number;
  grade: string;
  claims: ClaimReport[];
  sources: Source[];
  summary: {
    verdictCounts: Record<Verdict, number>;
    totalCalls: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    jevCostUsd: number;
    llmJudgeCostUsd: number;
  };
  createdAt: string;
}

export const VERDICT_META: Record<Verdict, { label: string; icon: string; colorKey: string }> = {
  supported: { label: "Supported", icon: "check-circle", colorKey: "green" },
  partially_supported: { label: "Partially supported", icon: "circle-check-half", colorKey: "lime" },
  unsupported: { label: "Unsupported", icon: "circle-slash", colorKey: "amber" },
  contradicted: { label: "Contradicted", icon: "x-octagon", colorKey: "red" },
  misquoted: { label: "Misquoted", icon: "quote-x", colorKey: "purple" },
  uncertain: { label: "Needs review", icon: "help-circle", colorKey: "amber" },
};

export const VERDICT_WEIGHT: Record<Verdict, number> = {
  supported: 1.0,
  partially_supported: 0.6,
  uncertain: 0.4,
  unsupported: 0.1,
  contradicted: 0.0,
  misquoted: 0.0,
};
