import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // functions.invoke surfaces HTTP errors as FunctionHttpError with context
    const ctx = (error as unknown as { context?: Record<string, unknown> }).context;
    const ctxError = ctx && typeof ctx === "object" && typeof ctx.error === "string" ? ctx.error : null;
    throw new Error(ctxError ?? error.message);
  }
  if (data && typeof data === "object" && "error" in data && typeof (data as Record<string, unknown>).error === "string") {
    throw new Error(String((data as Record<string, unknown>).error));
  }
  return data as T;
}
