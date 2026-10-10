import type { CheckReport } from "./types";

const VERDICT_LABEL: Record<string, string> = {
  supported: "Supported",
  partially_supported: "Partially supported",
  unsupported: "Unsupported",
  contradicted: "Contradicted",
  misquoted: "Misquoted",
  uncertain: "Needs review",
};

export function reportToMarkdown(r: CheckReport): string {
  const lines: string[] = [];
  lines.push(`# Citation Check: ${r.title}`);
  lines.push("");
  lines.push(`**Trust score:** ${r.trustScore}/100 (grade ${r.grade})`);
  lines.push(`**LLM mode:** ${r.llmMode} | **Jev mode:** ${r.jevMode}`);
  lines.push(`**Jev cost:** $${r.summary.jevCostUsd.toFixed(6)} vs LLM-judge estimate $${r.summary.llmJudgeCostUsd.toFixed(6)}`);
  lines.push("");
  lines.push(`## Verdicts (${r.claims.length} claims)`);
  for (const [v, n] of Object.entries(r.summary.verdictCounts)) {
    lines.push(`- ${VERDICT_LABEL[v] ?? v}: ${n}`);
  }
  lines.push("");
  lines.push("## Claims");
  lines.push("");
  lines.push("| # | Claim | Verdict | Matched passage | Reasoning |");
  lines.push("|---|-------|---------|-----------------|-----------|");
  for (const c of r.claims) {
    const passage = c.matched ? `"${c.matched.text.slice(0, 120)}${c.matched.text.length > 120 ? "..." : ""}" (${c.matched.id})` : "—";
    const reasoning = (c.reasoning ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
    const text = c.text.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${c.idx + 1} | ${text} | ${VERDICT_LABEL[c.verdict] ?? c.verdict} | ${passage} | ${reasoning} |`);
  }
  lines.push("");
  lines.push(`_Generated ${new Date(r.createdAt).toLocaleString()} — all demo sources are fictional._`);
  return lines.join("\n");
}

export function reportToJson(r: CheckReport): string {
  return JSON.stringify(r, null, 2);
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
