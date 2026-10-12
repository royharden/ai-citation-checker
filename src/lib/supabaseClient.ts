import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Never crash on load: a missing or malformed config just disables live calls (demos keep working)
function makeClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  try {
    return createClient(supabaseUrl, supabaseAnonKey);
  } catch (e) {
    console.error("Invalid Supabase configuration — live calls are disabled", e);
    return null;
  }
}

const client = makeClient();

export const supabaseConfigured = client !== null;

export const supabase: SupabaseClient = client ?? (null as unknown as SupabaseClient);

// Machine-readable error codes returned by the Edge Functions, shown as readable text
const ERROR_MESSAGES: Record<string, string> = {
  daily_limit: "Daily demo limit reached",
  too_many_claims: "Live Jev checks are limited to 10 claims per run",
};

export class EdgeFunctionError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null) {
    super(message);
    this.name = "EdgeFunctionError";
  }
}

export function isDailyLimitError(e: unknown): boolean {
  return e instanceof EdgeFunctionError && e.status === 429 && e.code === "daily_limit";
}

// FunctionsHttpError.context is the raw Response: read its status and { error } body
async function readErrorContext(error: unknown): Promise<{ status: number | null; serverError: string | null }> {
  const ctx = (error as { context?: unknown }).context;
  if (!(ctx instanceof Response)) return { status: null, serverError: null };
  let serverError: string | null = null;
  try {
    const payload: unknown = await ctx.clone().json();
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (typeof p.error === "string") serverError = p.error;
      else if (typeof p.message === "string") serverError = p.message;
    }
  } catch {
    // non-JSON error body
  }
  return { status: ctx.status, serverError };
}

export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  if (!supabaseConfigured) {
    throw new Error("Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable live calls. Demos still work in Replay mode.");
  }
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const { status, serverError } = await readErrorContext(error);
    const message = serverError ? (ERROR_MESSAGES[serverError] ?? serverError) : error.message;
    throw new EdgeFunctionError(message, status, serverError);
  }
  if (data && typeof data === "object" && "error" in data && typeof (data as Record<string, unknown>).error === "string") {
    throw new Error(String((data as Record<string, unknown>).error));
  }
  return data as T;
}
