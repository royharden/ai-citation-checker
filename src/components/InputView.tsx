import { useState, useEffect } from "react";
import { FileText, Link2, Trash2, Plus, Loader2, AlertTriangle, ShieldAlert, ArrowRight } from "lucide-react";
import type { Source } from "@/lib/types";
import { invokeFn } from "@/lib/supabaseClient";

interface FetchResult {
  url: string;
  title: string | null;
  text: string;
  error: string | null;
}

interface InputViewProps {
  answer: string;
  setAnswer: (a: string) => void;
  sources: Source[];
  setSources: (s: Source[]) => void;
  onRun: () => void;
  running: boolean;
}

export function InputView({ answer, setAnswer, sources, setSources, onRun, running }: InputViewProps) {
  const [urlDraft, setUrlDraft] = useState("");

  async function fetchUrl(url: string) {
    const tempId = `url-${Date.now()}`;
    const placeholder: Source = {
      id: tempId,
      label: "",
      kind: "url",
      url,
      title: url,
      content: "",
      fetch_error: null,
      suspicious: false,
    };
    const next = [...sources, placeholder];
    setSources(next);

    try {
      const res = await invokeFn<{ results: FetchResult[] }>("fetch-sources", { urls: [url] });
      const r = res.results[0];
      setSources(
        next.map((s) =>
          s.id === tempId
            ? {
                ...s,
                title: r.title ?? url,
                content: r.text ?? "",
                fetch_error: r.error,
              }
            : s
        )
      );
    } catch (e) {
      setSources(
        next.map((s) =>
          s.id === tempId ? { ...s, fetch_error: e instanceof Error ? e.message : "Fetch failed" } : s
        )
      );
    }
  }

  function addTextSource() {
    setSources([
      ...sources,
      {
        id: `text-${Date.now()}`,
        label: "",
        kind: "text",
        url: null,
        title: "Pasted source",
        content: "",
        fetch_error: null,
        suspicious: false,
      },
    ]);
  }

  function updateSource(id: string, patch: Partial<Source>) {
    setSources(sources.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeSource(id: string) {
    setSources(sources.filter((s) => s.id !== id));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <FileText className="w-4 h-4 text-indigo-500" /> AI answer
          </label>
          <span className="text-xs text-slate-400">{answer.trim() ? `${answer.trim().split(/\s+/).length} words` : "Paste the answer to check"}</span>
        </div>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Paste an AI-generated answer that includes claims and citations like [1], [2]..."
          className="w-full h-[420px] resize-y rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-4 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button onClick={onRun} disabled={running || !answer.trim()} className="btn-primary mt-4 w-full justify-center">
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          {running ? "Checking..." : "Check citations"}
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Sources <span className="text-slate-400 font-normal">({sources.length})</span>
          </h3>
          <div className="flex gap-2">
            <button onClick={addTextSource} className="btn-secondary !py-1.5 !px-3 text-xs">
              <Plus className="w-3.5 h-3.5" /> Paste text
            </button>
          </div>
        </div>

        <div className="card p-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                className="input pl-9"
                placeholder="Add a source URL (fetched automatically)..."
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && urlDraft.trim()) {
                    fetchUrl(urlDraft.trim());
                    setUrlDraft("");
                  }
                }}
              />
            </div>
            <button
              className="btn-secondary"
              disabled={!urlDraft.trim()}
              onClick={() => {
                fetchUrl(urlDraft.trim());
                setUrlDraft("");
              }}
            >
              Fetch
            </button>
          </div>
        </div>

        <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
          {sources.map((s, i) => (
            <SourceCard
              key={s.id}
              source={s}
              index={i}
              onChange={(patch) => updateSource(s.id, patch)}
              onRemove={() => removeSource(s.id)}
            />
          ))}
          {sources.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">
              No sources yet. Paste text or add a URL — sources get labels [1], [2], ... in order.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceCard({ source, index, onChange, onRemove }: { source: Source; index: number; onChange: (p: Partial<Source>) => void; onRemove: () => void }) {
  const [fetching, setFetching] = useState(false);
  const label = source.label || `[${index + 1}]`;
  const words = source.content.trim() ? source.content.trim().split(/\s+/).length : 0;

  async function retryAsText() {
    if (!source.url) return;
    setFetching(true);
    try {
      const res = await invokeFn<{ results: FetchResult[] }>("fetch-sources", { urls: [source.url] });
      const r = res.results[0];
      onChange(r.error ? { fetch_error: r.error } : { content: r.text, title: r.title ?? source.title, fetch_error: null });
    } catch (e) {
      onChange({ fetch_error: e instanceof Error ? e.message : "Fetch failed" });
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className={`card p-4 ${source.fetch_error ? "border-red-300 dark:border-red-800" : ""}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="chip bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 shrink-0">{label}</span>
          {source.kind === "url" && fetching && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />}
          <span className="text-sm font-medium truncate">{source.title ?? "Untitled source"}</span>
        </div>
        <button onClick={onRemove} className="text-slate-400 hover:text-red-500 transition shrink-0" title="Remove source">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {source.kind === "url" && source.url && (
        <p className="text-xs text-slate-400 truncate mb-2">{source.url}</p>
      )}

      {source.suspicious && (
        <div className="flex items-center gap-1.5 chip bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 mb-2">
          <ShieldAlert className="w-3 h-3" /> Suspicious: instructions to AI
        </div>
      )}

      {source.fetch_error ? (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 p-3">
          <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p>{source.fetch_error}</p>
              <div className="mt-2 flex gap-2">
                <button onClick={retryAsText} className="underline font-medium hover:no-underline">
                  Try again
                </button>
                <span className="text-red-400">or paste the text below instead</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <textarea
        value={source.content}
        onChange={(e) => onChange({ content: e.target.value })}
        placeholder="Paste the source text here..."
        className="mt-2 w-full h-28 resize-y rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <p className="mt-1 text-xs text-slate-400">{words} words</p>
    </div>
  );
}
