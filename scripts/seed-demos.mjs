import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';

config();

const demos = JSON.parse(readFileSync('src/data/demos.json', 'utf8')).demos;
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

