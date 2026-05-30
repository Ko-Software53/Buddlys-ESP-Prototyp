import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Surfaced in the UI rather than crashing white-screen.
  console.error('[dashboard] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — copy .env.example to .env.local');
}

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'anon', {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const supabaseConfigured = Boolean(url && anonKey);
