import demosData from "@/data/demos.json";
import type { Source } from "./types";

export interface DemoDef {
  slug: string;
  title: string;
  answer_text: string;
  sources: { label: string; kind: "text" | "url"; title: string; content: string }[];
  recorded_jev: Record<string, unknown>;
}

export const DEMOS: DemoDef[] = (demosData as { demos: DemoDef[] }).demos;

export function demoBySlug(slug: string): DemoDef | null {
  return DEMOS.find((d) => d.slug === slug) ?? null;
}

export function demoSources(demo: DemoDef): Source[] {
  return demo.sources.map((s, i) => ({
    id: `demo-${demo.slug}-${i}`,
    label: s.label || `[${i + 1}]`,
    kind: s.kind,
    url: null,
    title: s.title,
    content: s.content,
    fetch_error: null,
    suspicious: false,
  }));
}
