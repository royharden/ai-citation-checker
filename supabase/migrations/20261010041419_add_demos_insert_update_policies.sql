/*
# Add missing INSERT and UPDATE policies for demos

1. Security
- The demos seed previously only had a SELECT policy, so upserts from the seed script failed RLS.
- Adds idempotent INSERT and UPDATE policies for anon + authenticated, matching the permissive single-workspace demo model.
*/

DROP POLICY IF EXISTS "anon_insert_demos" ON demos;
CREATE POLICY "anon_insert_demos" ON demos FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_demos" ON demos;
CREATE POLICY "anon_update_demos" ON demos FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
