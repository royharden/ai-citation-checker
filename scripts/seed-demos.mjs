import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';

config();

const demos = JSON.parse(readFileSync('src/data/demos.json', 'utf8')).demos;
// Local-only script: the service-role key comes from your local .env and is never committed
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in your local .env to seed demos.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceRoleKey);

for (const d of demos) {
  console.log('seeding', d.slug);
  const { error } = await supabase.from('demos').upsert(
    {
      slug: d.slug,
      title: d.title,
      answer_text: d.answer_text,
      sources: d.sources,
      recorded_jev: d.recorded_jev,
    },
    { onConflict: 'slug' }
  );
  if (error) throw error;
  console.log('seeded', d.slug);
}

