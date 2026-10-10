import { FileSearch, ListChecks, Crosshair, Scale, Flag, ClipboardCheck, FileDown } from "lucide-react";

const STAGES = [
  { key: "answer", label: "Answer", icon: FileSearch },
  { key: "extract", label: "Claims", icon: ListChecks },
  { key: "passages", label: "Passage match", icon: Crosshair },
  { key: "jev", label: "Jev pick", icon: Scale },
  { key: "verdict", label: "Jev verdict", icon: Flag },
  { key: "checks", label: "Code checks", icon: ClipboardCheck },
  { key: "report", label: "Report", icon: FileDown },
];

export function PipelineStrip({
  running,
  stageInfo,
  claimCount,
  elapsedMs,
}: {
  running: boolean;
  stageInfo: Record<string, Record<string, unknown>>;
  claimCount: number | null;
  elapsedMs: number | null;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 overflow-x-auto">
        {STAGES.map((s, i) => {
          const info = stageInfo[s.key];
          const isRunning = running && info?.status === "running";
          const done = info?.status === "done" || s.key === "answer";
          const Icon = s.icon;
          return (
            <div key={s.key} className="flex items-center gap-2 shrink-0">
              {i > 0 && <div className={`w-6 h-px ${done ? "bg-indigo-400" : "bg-slate-200 dark:bg-slate-700"}`} />}
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  isRunning
                    ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300"
                    : done
                      ? "text-slate-700 dark:text-slate-300"
                      : "text-slate-400"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isRunning ? "animate-pulse" : ""}`} />
                {s.label}
                {s.key === "extract" && claimCount !== null && <span className="chip bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{claimCount}</span>}
                {info?.ms ? <span className="text-slate-400">{Math.round(info.ms as number)}ms</span> : null}
              </div>
            </div>
          );
        })}
        {elapsedMs !== null && <span className="ml-auto text-xs text-slate-400 shrink-0">{(elapsedMs / 1000).toFixed(1)}s total</span>}
      </div>
    </div>
  );
}
