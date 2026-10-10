/*
# Citation Checker schema + demo seed

1. New Tables
- `checks` — one citation-check run. Stores the pasted AI answer, which demo it came from (if any), LLM/Jev modes, trust score (0-100), letter grade, a summary jsonb (verdict counts + pipeline stats), and Jev cost in USD.
- `sources` — the pasted or fetched sources for a check. kind is 'text' | 'url'; stores fetched title, extracted content, fetch error, and a `suspicious` bool for sources that contain instructions aimed at AI tools.
- `claims` — one row per atomic claim or direct quote split out of the answer. Stores kind ('claim' | 'quote'), text, exact quote text, char span in the answer, cited marker, candidate + matched passages (jsonb), the full Jev request/response (jsonb) for the raw JSON viewer, verdict, probabilities, confidence, code checks, flags, LLM reasoning + suggested fix, latency, token usage, and cost.
- `demos` — the four built-in one-click demos: title, the answer text, sources, and recorded Jev answers (fixtures) so Replay mode works with no API keys.

2. Security
- RLS enabled on all four tables.
- Permissive anon policies (SELECT/INSERT/UPDATE/DELETE, TO anon, authenticated, USING/WITH CHECK (true)) because this is a single public demo workspace with no auth.

3. Notes
- All demo data is fictional: Lake Varna, Halvren-12, Brightpath, and every person/company/number are invented.
- Recorded Jev fixtures are clearly labeled Replay data, never presented as live calls.
*/

CREATE TABLE IF NOT EXISTS checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'Untitled check',
  answer_text text NOT NULL,
  demo_slug text,
  llm_mode text NOT NULL DEFAULT 'mock',
  jev_mode text NOT NULL DEFAULT 'replay',
  trust_score numeric,
  grade text,
  summary jsonb,
  jev_cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  url text,
  title text,
  content text NOT NULL DEFAULT '',
  fetch_error text,
  suspicious boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  idx int NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  quote_text text,
  char_start int,
  char_end int,
  cited_source text,
  candidate_passages jsonb,
  matched_passage jsonb,
  jev_request jsonb,
  jev_response jsonb,
  model text,
  verdict text,
  probabilities jsonb,
  confidence numeric,
  code_checks jsonb,
  flags jsonb,
  reasoning text,
  suggested_fix text,
  latency_ms int,
  input_tokens int,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demos (
  slug text PRIMARY KEY,
  title text NOT NULL,
  answer_text text NOT NULL,
  sources jsonb NOT NULL,
  recorded_jev jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_check ON sources(check_id);
CREATE INDEX IF NOT EXISTS idx_claims_check ON claims(check_id, idx);

ALTER TABLE checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE demos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_checks" ON checks;
CREATE POLICY "anon_select_checks" ON checks FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_checks" ON checks;
CREATE POLICY "anon_insert_checks" ON checks FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_checks" ON checks;
CREATE POLICY "anon_update_checks" ON checks FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_checks" ON checks;
CREATE POLICY "anon_delete_checks" ON checks FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_sources" ON sources;
CREATE POLICY "anon_select_sources" ON sources FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_sources" ON sources;
CREATE POLICY "anon_insert_sources" ON sources FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_sources" ON sources;
CREATE POLICY "anon_update_sources" ON sources FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_sources" ON sources;
CREATE POLICY "anon_delete_sources" ON sources FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_claims" ON claims;
CREATE POLICY "anon_select_claims" ON claims FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_claims" ON claims;
CREATE POLICY "anon_insert_claims" ON claims FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_claims" ON claims;
CREATE POLICY "anon_update_claims" ON claims FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_claims" ON claims;
CREATE POLICY "anon_delete_claims" ON claims FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_demos" ON demos;
CREATE POLICY "anon_select_demos" ON demos FOR SELECT TO anon, authenticated USING (true);
