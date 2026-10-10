import { useMemo } from "react";
import { motion } from "framer-motion";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { CheckReport, Verdict } from "@/lib/types";
import { verdictIcon, verdictClasses, VERDICT_LABEL } from "@/lib/verdictUi";
import { findCharSpan } from "@/lib/pipeline";

interface ReportViewProps {
  report: CheckReport;
  selectedClaimId: string | null;
  onSelectClaim: (id: string | null) => void;
  filter: "all" | "problems" | "quotes";
}

const VERDICT_ORDER: Verdict[] = ["supported", "partially_supported", "unsupported", "contradicted", "misquoted", "uncertain"];

function gradeColor(grade: string): string {
  switch (grade) {
    case "A": return "text-green-600 dark:text-green-400";
    case "B": return "text-lime-600 dark:text-lime-400";
    case "C": return "text-amber-600 dark:text-amber-400";
    case "D": return "text-orange-600 dark:text-orange-400";
    default: return "text-red-600 dark:text-red-400";
  }
}

function TrustGauge({ score, grade }: { score: number; grade: string }) {
  const R = 52;
  const C = Math.PI * R; // half circle
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className="flex flex-col items-center">
      <svg width="140" height="84" viewBox="0 0 140 84">
        <path d="M 18 74 A 52 52 0 0 1 122 74" fill="none" stroke="#e2e8f0" strokeWidth="12" strokeLinecap="round" className="dark:opacity-20" />
        <path
          d="M 18 74 A 52 52 0 0 1 122 74"
          fill="none"
          stroke="currentColor"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${C * pct} ${C}`}
          className={gradeColor(grade)}
        />
        <text x="70" y="62" textAnchor="middle" className="fill-slate-900 dark:fill-slate-100 text-2xl font-bold">
          {Math.round(score)}
        </text>
        <text x="70" y="78" textAnchor="middle" className="fill-slate-400" fontSize="9">
          / 100
        </text>
      </svg>
      <div className={`text-3xl font-bold ${gradeColor(grade)}`}>{grade}</div>
      <p className="text-xs text-slate-400">Trust score &amp; grade</p>
    </div>
  );
}

export function ReportView({ report, selectedClaimId, onSelectClaim, filter }: ReportViewProps) {
  // Build segments: text outside claims + claim spans
  const segments = useMemo(() => {
    const answer = report.answerText;
    const spans = report.claims
      .filter((c) => filter !== "quotes" || c.kind === "quote")
      .map((c) => {
        let span = c.char_start !== null && c.char_end !== null ? { start: c.char_start, end: c.char_end } : findCharSpan(answer, c.text);
        return span ? { claim: c, ...span } : null;
      })
      .filter((s): s is { claim: (typeof report.claims)[number]; start: number; end: number } => s !== null)
      .sort((a, b) => a.start - b.start);

    const out: { text: string; claim: (typeof report.claims)[number] | null }[] = [];
    let pos = 0;
    for (const s of spans) {
      if (s.start < pos) continue; // overlapping claim, skip
      if (s.start > pos) out.push({ text: answer.slice(pos, s.start), claim: null });
      out.push({ text: answer.slice(s.start, s.end), claim: s.claim });
      pos = s.end;
    }
    if (pos < answer.length) out.push({ text: answer.slice(pos), claim: null });
    return out;
  }, [report, filter]);

  const visibleClaims = report.claims.filter((c) => {
    if (filter === "problems") return c.verdict !== "supported";
    if (filter === "quotes") return c.kind === "quote";
    return true;
  });

  const barData = VERDICT_ORDER.map((v) => ({
    name: VERDICT_LABEL[v],
    value: report.summary.verdictCounts[v] ?? 0,
    verdict: v,
  })).filter((d) => d.value > 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        {/* Score + chart */}
        <div className="card p-5">
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <TrustGauge score={report.trustScore} grade={report.grade} />
            <div className="flex-1 w-full min-w-0">
              <p className="text-sm font-semibold mb-2">Verdict breakdown</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <XAxis type="number" allowDecimals={false} hide />
                    <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={16}>
                      {barData.map((d) => (
                        <Cell key={d.verdict} className={fillFor(d.verdict)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>

        {/* Annotated answer */}
        <div className="card p-5">
          <p className="text-sm font-semibold mb-3">
            Annotated answer <span className="font-normal text-slate-400">— click a highlighted claim for details</span>
          </p>
          <p className="text-sm leading-[1.9] whitespace-pre-wrap">
            {segments.map((seg, i) =>
              seg.claim ? (
                <ClaimSpan
                  key={`${seg.claim!.id}-${i}`}
                  claim={seg.claim!}
                  selected={seg.claim!.id === selectedClaimId}
                  onClick={() => onSelectClaim(seg.claim!.id)}
                >
                  {seg.text}
                </ClaimSpan>
              ) : (
                <span key={i}>{seg.text}</span>
              )
            )}
          </p>
        </div>

        {/* Claim list for scanning */}
        <div className="card p-5">
          <p className="text-sm font-semibold mb-3">All claims ({visibleClaims.length})</p>
          <div className="space-y-2">
            {visibleClaims.map((c) => {
              const Icon = verdictIcon[c.verdict];
              const vc = verdictClasses[c.verdict];
              return (
                <button
                  key={c.id}
                  onClick={() => onSelectClaim(c.id)}
                  className={`w-full text-left flex items-start gap-3 p-3 rounded-xl border transition hover:shadow-sm ${
                    c.id === selectedClaimId ? `${vc.bg} ${vc.border}` : "border-slate-200 dark:border-slate-800 hover:border-slate-300"
                  }`}
                >
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${vc.solid}`} />
                  <div className="min-w-0">
                    <p className="text-sm line-clamp-2">{c.text}</p>
                    <p className={`text-xs mt-0.5 ${vc.text}`}>
                      {VERDICT_LABEL[c.verdict]}
                      {c.confidence !== null && ` · ${(c.confidence * 100).toFixed(0)}% confidence`}
                      {c.flags.length > 0 && ` · ${c.flags.join(", ")}`}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Side panel */}
      <div className="lg:sticky lg:top-6 self-start">
        {selectedClaimId ? (
          <ClaimSidePanel
            report={report}
            claimId={selectedClaimId}
            onClose={() => onSelectClaim(null)}
          />
        ) : (
          <div className="card p-6 text-center text-sm text-slate-400">
            Select a claim in the annotated answer to see the matched passage, Jev's probabilities, code checks, and reasoning.
          </div>
        )}
      </div>
    </div>
  );
}

function fillFor(v: Verdict): string {
  switch (v) {
    case "supported": return "fill-green-500";
    case "partially_supported": return "fill-lime-500";
    case "unsupported":
    case "uncertain": return "fill-amber-500";
    case "contradicted": return "fill-red-500";
    case "misquoted": return "fill-purple-500";
  }
}

function ClaimSpan({ claim, selected, onClick, children }: { claim: CheckReport["claims"][number]; selected: boolean; onClick: () => void; children: React.ReactNode }) {
  const vc = verdictClasses[claim.verdict];
  const Icon = verdictIcon[claim.verdict];
  return (
    <motion.mark
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClick}
      title={`${VERDICT_LABEL[claim.verdict]}${claim.confidence !== null ? ` (${(claim.confidence * 100).toFixed(0)}%)` : ""}`}
      className={`cursor-pointer rounded px-0.5 decoration-2 underline underline-offset-4 transition-colors ${vc.bg} ${vc.text} ${
        selected ? `ring-2 ${vc.border}` : "hover:brightness-95"
      }`}
    >
      {children}
      <Icon className="inline w-3 h-3 ml-0.5 -mt-0.5" />
    </motion.mark>
  );
}

function ClaimSidePanel({ report, claimId, onClose }: { report: CheckReport; claimId: string; onClose: () => void }) {
  const c = report.claims.find((x) => x.id === claimId);
  if (!c) return null;
  const vc = verdictClasses[c.verdict];
  const Icon = verdictIcon[c.verdict];
  const probs = c.probabilities ? Object.entries(c.probabilities).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="card overflow-hidden">
      <div className={`p-4 border-b ${vc.bg}`}>
        <div className="flex items-center justify-between mb-2">
          <span className={`chip ${vc.bg} ${vc.text} ${vc.border} border`}>
            <Icon className="w-3 h-3" /> {VERDICT_LABEL[c.verdict]}
          </span>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 text-xs">
            Close
          </button>
        </div>
        <p className="text-sm font-medium leading-relaxed line-clamp-4">{c.text}</p>
        {c.confidence !== null && <p className={`text-xs mt-1 ${vc.text}`}>{(c.confidence * 100).toFixed(0)}% confidence · {c.model ?? "unknown model"}</p>}
      </div>

      <div className="p-4 space-y-4 max-h-[calc(100vh-220px)] overflow-y-auto text-sm">
        {/* Probabilities */}
        {probs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Jev probabilities</p>
            <div className="space-y-1.5">
              {probs.map(([k, v]) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 text-xs text-slate-500 truncate">{VERDICT_LABEL[k as Verdict] ?? k}</span>
                  <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${v * 100}%` }}
                      className={`h-full rounded-full ${barColor(k as Verdict)}`}
                    />
                  </div>
                  <span className="w-10 text-right text-xs text-slate-500">{(v * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Code check chips */}
        {c.code_checks.chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {c.code_checks.chips.map((chip) => (
              <span key={chip} className="chip bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{chip}</span>
            ))}
          </div>
        )}
        {c.flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {c.flags.map((f) => (
              <span key={f} className="chip bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900">{f}</span>
            ))}
          </div>
        )}

        {/* Matched passage */}
        {c.matched ? (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Matched passage · {c.matched.id}</p>
            <blockquote className="rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 text-xs leading-relaxed">
              {c.matched.text}
            </blockquote>
            <p className="text-xs text-slate-400 mt-1">
              {c.matched.sourceTitle ?? c.matched.sourceLabel}
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-400">No passage was matched to this claim.</p>
        )}

        {/* Reasoning */}
        {c.reasoning && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Reasoning</p>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">{c.reasoning}</p>
          </div>
        )}

        {/* Suggested fix */}
        {c.suggested_fix && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Suggested fix</p>
            <div className="rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 p-3 text-xs leading-relaxed">
              {c.suggested_fix}
              <button
                onClick={() => navigator.clipboard.writeText(c.suggested_fix!)}
                className="block mt-2 text-green-700 dark:text-green-400 font-medium underline"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
          <span>{c.latency_ms !== null ? `${c.latency_ms} ms` : "latency n/a"}</span>
          <span>{c.cost_usd !== null ? `$${c.cost_usd.toFixed(8)}` : "cost n/a"}</span>
        </div>

        {/* Raw JSON */}
        <details className="group">
          <summary className="cursor-pointer text-xs font-semibold text-slate-500 uppercase tracking-wide">Raw JSON</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-950 text-slate-300 p-3 text-[10px] leading-relaxed">
{JSON.stringify({ request: c.jev_request, response: c.jev_response }, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

function barColor(v: Verdict): string {
  switch (v) {
    case "supported": return "bg-green-500";
    case "partially_supported": return "bg-lime-500";
    case "unsupported":
    case "uncertain": return "bg-amber-500";
    case "contradicted": return "bg-red-500";
    case "misquoted": return "bg-purple-500";
  }
}
