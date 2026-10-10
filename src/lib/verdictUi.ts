import {
  CheckCircle2,
  CircleDot,
  CircleSlash,
  OctagonX,
  MessageSquareQuote,
  HelpCircle,
} from "lucide-react";
import type { Verdict } from "./types";

export const verdictIcon: Record<Verdict, typeof CheckCircle2> = {
  supported: CheckCircle2,
  partially_supported: CircleDot,
  unsupported: CircleSlash,
  contradicted: OctagonX,
  misquoted: MessageSquareQuote,
  uncertain: HelpCircle,
};

export const verdictClasses: Record<Verdict, { bg: string; text: string; border: string; solid: string; underline: string }> = {
  supported: {
    bg: "bg-green-100 dark:bg-green-950/60",
    text: "text-green-800 dark:text-green-300",
    border: "border-green-300 dark:border-green-700",
    solid: "text-green-600 dark:text-green-400",
    underline: "decoration-green-500",
  },
  partially_supported: {
    bg: "bg-lime-100 dark:bg-lime-950/60",
    text: "text-lime-800 dark:text-lime-300",
    border: "border-lime-300 dark:border-lime-700",
    solid: "text-lime-600 dark:text-lime-400",
    underline: "decoration-lime-500",
  },
  unsupported: {
    bg: "bg-amber-100 dark:bg-amber-950/60",
    text: "text-amber-800 dark:text-amber-300",
    border: "border-amber-300 dark:border-amber-700",
    solid: "text-amber-600 dark:text-amber-400",
    underline: "decoration-amber-500",
  },
  contradicted: {
    bg: "bg-red-100 dark:bg-red-950/60",
    text: "text-red-800 dark:text-red-300",
    border: "border-red-300 dark:border-red-700",
    solid: "text-red-600 dark:text-red-400",
    underline: "decoration-red-500",
  },
  misquoted: {
    bg: "bg-purple-100 dark:bg-purple-950/60",
    text: "text-purple-800 dark:text-purple-300",
    border: "border-purple-300 dark:border-purple-700",
    solid: "text-purple-600 dark:text-purple-400",
    underline: "decoration-purple-500",
  },
  uncertain: {
    bg: "bg-amber-100 dark:bg-amber-950/60",
    text: "text-amber-800 dark:text-amber-300",
    border: "border-amber-300 dark:border-amber-700",
    solid: "text-amber-600 dark:text-amber-400",
    underline: "decoration-amber-500",
  },
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  supported: "Supported",
  partially_supported: "Partially supported",
  unsupported: "Unsupported",
  contradicted: "Contradicted",
  misquoted: "Misquoted",
  uncertain: "Needs review",
};
