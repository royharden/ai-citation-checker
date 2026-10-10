import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : (null as unknown as SupabaseClient);

export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  if (!supabaseConfigured) {
    throw new Error("Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable live calls. Demos still work in Replay mode.");
  }
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const ctx = (error as unknown as { context?: Record<string, unknown> }).context;
    const ctxError = ctx && typeof ctx === "object" && typeof ctx.error === "string" ? ctx.error : null;
    throw new Error(ctxError ?? error.message);
  }
  if (data && typeof data === "object" && "error" in data && typeof (data as Record<string, unknown>).error === "string") {
    throw new Error(String((data as Record<string, unknown>).error));
  }
  return data as T;
}
