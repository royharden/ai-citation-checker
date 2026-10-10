import { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  Sun,
  Moon,
  Waves,
  FlaskConical,
  TrendingUp,
  Biohazard,
  Download,
  FileJson,
  Printer,
  Link as LinkIcon,
  History,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { InputView } from "@/components/InputView";
import { PipelineStrip } from "@/components/PipelineStrip";
import { ReportView } from "@/components/ReportView";
import { runCheck, saveCheck, loadCheck, listPastChecks } from "@/lib/pipeline";
import { DEMOS, demoBySlug, demoSources } from "@/lib/demos";
import type { Source, CheckReport } from "@/lib/types";
import { reportToMarkdown, reportToJson, download } from "@/lib/exportReport";
import { BadgeCheck, Clock } from "lucide-react";

const DEMO_ICONS: Record<string, typeof Waves> = {
  "lake-varna": Waves,
  halvren: FlaskConical,
  brightpath: TrendingUp,
  poisoned: Biohazard,
};

function demoIcon(slug: string | undefined) {
  if (!slug) return ShieldCheck;
  if (slug.startsWith("lake")) return Waves;
  if (slug.startsWith("halvren")) return FlaskConical;
  if (slug.startsWith("brightpath")) return TrendingUp;
  if (slug.startsWith("poisoned")) return Biohazard;
  return ShieldCheck;
}

export default function App() {
  const [dark, setDark] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "problems" | "quotes">("all");
  const [stageInfo, setStageInfo] = useState<Record<string, Record<string, unknown>>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [currentDemo, setCurrentDemo] = useState<string | null>(null);
  const recordedJevRef = useRef<Record<string, unknown> | null>(null);
  const [pastChecks, setPastChecks] = useState<{ id: string; title: string; trust_score: number | null; grade: string | null; created_at: string }[]>([]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const refreshPast = useCallback(() => {
    listPastChecks().then(setPastChecks).catch(() => {});
  }, []);
  useEffect(refreshPast, [refreshPast]);

  function loadDemo(slug: string) {
    const demo = demoBySlug(slug);
    if (!demo) return;
    setAnswer(demo.answer_text);
    setSources(demoSources(demo));
    setCurrentDemo(slug);
    recordedJevRef.current = demo.recorded_jev;
    setReport(null);
    setSelectedClaimId(null);
    setError(null);
    setNotices([]);
  }

  async function handleRun() {
    setRunning(true);
    setError(null);
    setNotices([]);
    setStageInfo({});
    setReport(null);
    setSelectedClaimId(null);
    const start = Date.now();
    try {
      const r = await runCheck({
        answer,
        sources,
        title: currentDemo ? (demoBySlug(currentDemo)?.title ?? "Check") : "Custom check",
        demoSlug: currentDemo,
        recordedJev: recordedJevRef.current,
        onStage: (stage, info) => {
          setStageInfo((prev) => ({ ...prev, [stage]: info }));
          if (stage === "notice" && typeof info.message === "string") {
            const msg: string = info.message;
            setNotices((prev) => [...prev, msg]);
          }
        },
      });
      setElapsed(Date.now() - start);
      setReport(r);
      try {
        const id = await saveCheck(r);
        setReport({ ...r, id });
        refreshPast();
      } catch {
        setNotices((prev) => [...prev, "Report could not be saved — copy link and past checks are unavailable for this run."]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  }

  async function openSaved(id: string) {
    try {
      const r = await loadCheck(id);
      if (r) {
        setReport(r);
        setAnswer(r.answerText);
        setSources(r.sources);
        setCurrentDemo(r.demoSlug);
        recordedJevRef.current = null;
        setError(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load report");
    }
  }

  function copyLink() {
    if (!report?.id) return;
    const url = `${window.location.origin}/report/${report.id}`;
    navigator.clipboard.writeText(url);
    setNotices((prev) => [...prev, `Read-only link copied: ${url}`]);
  }

  const demoButtons = DEMOS.map((d) => {
    const Icon = demoIcon(d.slug);
    return { demo: d, Icon };
  });

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="font-bold leading-tight">Citation Checker</h1>
              <p className="text-xs text-slate-400 truncate">Does the answer actually say what its sources say?</p>
            </div>
          </div>
          <button
            onClick={() => setDark(!dark)}
            className="btn-secondary !px-3"
            title="Toggle dark mode"
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Notices / errors */}
        <AnimatePresence>
          {(error || notices.length > 0) && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-2">
              {error && (
                <div className="flex items-start gap-2 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 p-3 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
                </div>
              )}
              {notices.map((n, i) => (
                <div key={i} className="flex items-start gap-2 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 text-xs text-slate-600 dark:text-slate-300">
                  <BadgeCheck className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" /> {n}
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Intro + demos */}
        <section className={report ? "space-y-4" : "space-y-6"}>
          <div className={report ? "" : "text-center max-w-2xl mx-auto"}>
            {!report && (
              <>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                  Does the answer actually say what its sources say?
                </h2>
                <p className="text-slate-500 dark:text-slate-400 leading-relaxed mb-6">
                  Paste an AI answer and its sources. Every claim is split out, matched to the best source passage, and
                  judged by Jev — TypeSafe's fast System One model. Code finds passages and scores; Jev judges; the LLM only writes explanations.
                </p>
              </>
            )}
            <div className={`flex flex-wrap gap-2 ${report ? "" : "justify-center"}`}>
              {demoButtons.map(({ demo, Icon }) => (
                <button
                  key={demo.slug}
                  onClick={() => loadDemo(demo.slug)}
                  className={`btn-secondary ${currentDemo === demo.slug ? "!border-indigo-400 !text-indigo-600 dark:!text-indigo-300" : ""}`}
                >
                  <Icon className="w-4 h-4" /> {demo.title}
                </button>
              ))}
            </div>
          </div>

          {/* Past checks */}
          {pastChecks.length > 0 && !report && (
            <div className="card p-4">
              <p className="flex items-center gap-2 text-sm font-semibold mb-2">
                <History className="w-4 h-4 text-slate-400" /> Past checks
              </p>
              <div className="flex flex-wrap gap-2">
                {pastChecks.map((p) => (
                  <button key={p.id} onClick={() => openSaved(p.id)} className="btn-secondary !py-1.5 !px-3 text-xs">
                    <Clock className="w-3 h-3 text-slate-400" />
                    {p.title} · {p.trust_score !== null ? Math.round(p.trust_score) : "?"}{p.grade ? ` (${p.grade})` : ""}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input or report */}
          {!report && <InputView answer={answer} setAnswer={setAnswer} sources={sources} setSources={setSources} onRun={handleRun} running={running} />}

          {report && (
            <div className="space-y-4">
              {/* Mode badges + export */}
              <div className="flex flex-wrap items-center gap-2 no-print">
                <span className="chip bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                  LLM: {report.llmMode === "live" ? "Live" : "Mock"}
                </span>
                <span className={`chip ${report.jevMode === "replay" ? "bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-900" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"}`}>
                  {report.jevMode === "replay" && <BadgeCheck className="w-3 h-3" />}
                  Jev: {report.jevMode === "replay" ? "Replay — recorded Jev answers" : "Live"}
                </span>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button onClick={() => download("citation-report.md", reportToMarkdown(report), "text/markdown")} className="btn-secondary !py-1.5 !px-3 text-xs">
                    <Download className="w-3.5 h-3.5" /> Markdown
                  </button>
                  <button onClick={() => download("citation-report.json", reportToJson(report), "application/json")} className="btn-secondary !py-1.5 !px-3 text-xs">
                    <FileJson className="w-3.5 h-3.5" /> JSON
                  </button>
                  <button onClick={() => window.print()} className="btn-secondary !py-1.5 !px-3 text-xs">
                    <Printer className="w-3.5 h-3.5" /> PDF
                  </button>
                  {report.id && (
                    <button onClick={copyLink} className="btn-secondary !py-1.5 !px-3 text-xs">
                      <LinkIcon className="w-3.5 h-3.5" /> Copy link
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setReport(null);
                      setSelectedClaimId(null);
                    }}
                    className="btn-secondary !py-1.5 !px-3 text-xs"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Edit &amp; re-run
                  </button>
                </div>
              </div>

              <PipelineStrip running={running} stageInfo={stageInfo} claimCount={report.claims.length} elapsedMs={elapsed} />

              <ReportView report={report} selectedClaimId={selectedClaimId} onSelectClaim={setSelectedClaimId} filter={filter} />

              {/* Stats */}
              <div className="card p-5 no-print">
                <p className="text-sm font-semibold mb-3">Jev stats</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-2xl font-bold">{report.summary.totalCalls}</p>
                    <p className="text-xs text-slate-400">Jev calls</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{report.summary.avgLatencyMs} ms</p>
                    <p className="text-xs text-slate-400">Avg latency</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{report.summary.p95LatencyMs} ms</p>
                    <p className="text-xs text-slate-400">p95 latency</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">${report.summary.jevCostUsd.toFixed(6)}</p>
                    <p className="text-xs text-slate-400">
                      Jev cost · vs LLM judge ${report.summary.llmJudgeCostUsd.toFixed(4)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Filter chips (report view) */}
        {report && (
          <div className="flex gap-2 no-print">
            {(["all", "problems", "quotes"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`btn-secondary !py-1.5 !px-3 text-xs ${filter === f ? "!border-indigo-400 !text-indigo-600 dark:!text-indigo-300" : ""}`}
              >
                {f === "all" ? "All claims" : f === "problems" ? "Only problems" : "Only quotes"}
              </button>
            ))}
          </div>
        )}
      </main>

      <footer className="max-w-7xl mx-auto px-4 sm:px-6 pb-10 pt-4 text-xs text-slate-400">
        Demo workspace. All sources, people, companies, and numbers in the built-in examples are fictional. Jev answers in
        Replay mode are recorded fixtures, never live calls.
      </footer>
    </div>
  );
}
