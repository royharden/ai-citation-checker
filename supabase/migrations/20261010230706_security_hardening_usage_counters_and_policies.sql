/*
# Security hardening: usage counters, locked-down policies

1. New Tables
- `usage_counters` (fn text, day date, count int, PRIMARY KEY (fn, day)) — tracks daily invocations per Edge Function.
  RLS enabled. No policies for anon or authenticated. ALL privileges revoked from anon and authenticated.
  Only the service_role (which bypasses RLS) can read/write.

2. New Functions
- `increment_usage(fn text, day date) RETURNS int` — SECURITY DEFINER, fixed search_path = public.
  Atomically increments the daily counter with INSERT ... ON CONFLICT DO UPDATE.
  EXECUTE revoked from PUBLIC, anon, authenticated; granted only to service_role.

3. Security changes on existing tables
- checks: drop UPDATE and DELETE policies (anon keeps SELECT + INSERT).
- sources: drop UPDATE and DELETE policies (anon keeps SELECT + INSERT).
- claims: drop UPDATE and DELETE policies (anon keeps SELECT + INSERT).
- demos: drop INSERT and UPDATE policies (anon keeps SELECT only; seeding uses service_role key).

4. Notes
- The frontend saves reports (needs INSERT on checks/sources/claims) but never edits or deletes them.
- Demo seeding now uses the service_role key, so demos is SELECT-only for anon.
*/

CREATE TABLE IF NOT EXISTS usage_counters (
  fn text NOT NULL,
  day date NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (fn, day)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION increment_usage(fn text, day date)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count int;
BEGIN
  INSERT INTO usage_counters (fn, day, count) VALUES (fn, day, 1)
  ON CONFLICT (fn, day) DO UPDATE SET count = usage_counters.count + 1
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION increment_usage(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage(text, date) TO service_role;

-- Drop UPDATE and DELETE policies on checks
DROP POLICY IF EXISTS "anon_update_checks" ON checks;
DROP POLICY IF EXISTS "anon_delete_checks" ON checks;

-- Drop UPDATE and DELETE policies on sources
DROP POLICY IF EXISTS "anon_update_sources" ON sources;
DROP POLICY IF EXISTS "anon_delete_sources" ON sources;

-- Drop UPDATE and DELETE policies on claims
DROP POLICY IF EXISTS "anon_update_claims" ON claims;
DROP POLICY IF EXISTS "anon_delete_claims" ON claims;

-- Drop INSERT and UPDATE policies on demos (seed uses service_role key now)
DROP POLICY IF EXISTS "anon_insert_demos" ON demos;
DROP POLICY IF EXISTS "anon_update_demos" ON demos;
