/*
# Security fix 3: working usage counter, re-asserted lockdown, bounded anon inserts

1. increment_usage fix
- The previous plpgsql body failed on every call with
  `column reference "fn" is ambiguous` (the ON CONFLICT target clashed with the
  parameter names), so the fail-closed Edge Functions could never make a live call.
- Replaced (same name, same `fn text, day date` signature, same int result) with a
  LANGUAGE sql body: SECURITY DEFINER, SET search_path = public, atomic
  INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
- EXECUTE revoked from PUBLIC, anon, authenticated and granted only to service_role,
  for this and any other increment_usage overload that may exist.

2. usage_counters (re-asserted)
- RLS on, every policy dropped, ALL revoked from PUBLIC, anon, authenticated.

3. App data tables (checks, sources, claims, demos)
- Any anon/authenticated/public UPDATE, DELETE or FOR ALL policy is dropped, whatever its name.
  demos also loses any INSERT policy.
- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER revoked from anon and authenticated
  on all four tables; INSERT revoked on demos.
- anon keeps SELECT on all four tables.
- checks, sources and claims keep INSERT because the browser saves reports, but:
  - INSERT is granted only on a whitelist of columns (no id, no created_at), and
  - the INSERT policies now bound the size of every text/jsonb column.
*/

-- ---------------------------------------------------------------------------
-- 1. usage_counters lockdown
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
  fn text NOT NULL,
  day date NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (fn, day)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usage_counters'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.usage_counters', pol.policyname);
  END LOOP;
END $$;

REVOKE ALL ON usage_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. increment_usage: atomic, SECURITY DEFINER, service_role only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION increment_usage(fn text, day date)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.usage_counters AS uc (fn, day, count)
  VALUES (increment_usage.fn, increment_usage.day, 1)
  ON CONFLICT (fn, day) DO UPDATE SET count = uc.count + 1
  RETURNING uc.count;
$$;

REVOKE EXECUTE ON FUNCTION increment_usage(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage(text, date) TO service_role;

-- Lock down any other increment_usage overload the same way instead of keeping a second, open one.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'increment_usage'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. App data tables: no anon/authenticated UPDATE or DELETE, anywhere
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('checks', 'sources', 'claims', 'demos')
      AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
      -- INSERT policies are dropped too: demos gets none, the others are re-created bounded below
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON checks, sources, claims, demos FROM anon, authenticated;
REVOKE INSERT ON demos FROM anon, authenticated;

-- anon keeps SELECT (re-created in case a dropped FOR ALL policy was providing it)
GRANT SELECT ON checks, sources, claims, demos TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_checks" ON checks;
CREATE POLICY "anon_select_checks" ON checks FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_select_sources" ON sources;
CREATE POLICY "anon_select_sources" ON sources FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_select_claims" ON claims;
CREATE POLICY "anon_select_claims" ON claims FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_select_demos" ON demos;
CREATE POLICY "anon_select_demos" ON demos FOR SELECT TO anon, authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 4. Report saving: INSERT on whitelisted columns only, with bounded sizes
-- ---------------------------------------------------------------------------
REVOKE INSERT ON checks, sources, claims FROM anon, authenticated;

GRANT INSERT (title, answer_text, demo_slug, llm_mode, jev_mode, trust_score, grade, summary, jev_cost_usd)
  ON checks TO anon, authenticated;

GRANT INSERT (check_id, label, kind, url, title, content, fetch_error, suspicious)
  ON sources TO anon, authenticated;

GRANT INSERT (check_id, idx, kind, text, quote_text, char_start, char_end, cited_source,
              candidate_passages, matched_passage, jev_request, jev_response, model, verdict,
              probabilities, confidence, code_checks, flags, reasoning, suggested_fix,
              latency_ms, input_tokens, cost_usd)
  ON claims TO anon, authenticated;

DROP POLICY IF EXISTS "anon_insert_checks" ON checks;
CREATE POLICY "anon_insert_checks" ON checks FOR INSERT TO anon, authenticated
  WITH CHECK (
    octet_length(title) <= 1000
    AND octet_length(answer_text) <= 100000
    AND coalesce(octet_length(demo_slug), 0) <= 200
    AND octet_length(llm_mode) <= 20
    AND octet_length(jev_mode) <= 20
    AND coalesce(octet_length(grade), 0) <= 10
    AND coalesce(octet_length(summary::text), 0) <= 20000
  );

DROP POLICY IF EXISTS "anon_insert_sources" ON sources;
CREATE POLICY "anon_insert_sources" ON sources FOR INSERT TO anon, authenticated
  WITH CHECK (
    octet_length(label) <= 200
    AND octet_length(kind) <= 20
    AND coalesce(octet_length(url), 0) <= 8192
    AND coalesce(octet_length(title), 0) <= 8192
    AND octet_length(content) <= 300000
    AND coalesce(octet_length(fetch_error), 0) <= 4096
  );

DROP POLICY IF EXISTS "anon_insert_claims" ON claims;
CREATE POLICY "anon_insert_claims" ON claims FOR INSERT TO anon, authenticated
  WITH CHECK (
    octet_length(kind) <= 20
    AND octet_length(text) <= 20000
    AND coalesce(octet_length(quote_text), 0) <= 20000
    AND coalesce(octet_length(cited_source), 0) <= 8192
    AND coalesce(octet_length(model), 0) <= 200
    AND coalesce(octet_length(verdict), 0) <= 50
    AND coalesce(octet_length(reasoning), 0) <= 20000
    AND coalesce(octet_length(suggested_fix), 0) <= 20000
    AND coalesce(octet_length(candidate_passages::text), 0) <= 250000
    AND coalesce(octet_length(matched_passage::text), 0) <= 50000
    AND coalesce(octet_length(jev_request::text), 0) <= 200000
    AND coalesce(octet_length(jev_response::text), 0) <= 200000
    AND coalesce(octet_length(probabilities::text), 0) <= 10000
    AND coalesce(octet_length(code_checks::text), 0) <= 20000
    AND coalesce(octet_length(flags::text), 0) <= 10000
  );
