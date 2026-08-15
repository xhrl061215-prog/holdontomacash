/*
 * BudgetTracker — connection settings
 *
 * Replace the two placeholder values below with the ones from your Supabase
 * project, then save. That is the whole configuration step.
 *
 * Where to find them:
 *   Supabase → Project Settings (gear, bottom left) → API
 *     Project URL  →  SUPABASE_URL
 *     anon public  →  SUPABASE_ANON_KEY
 *
 * IMPORTANT: use the "anon public" key. Never the "service_role" key — that one
 * bypasses your security rules and would expose every user's data.
 *
 * The anon key is meant to be visible in a browser: your database denies every
 * row until it knows who is signed in.
 *
 * Changes here take effect on reload. No rebuild, no redeploy.
 */
window.BUDGET_TRACKER_CONFIG = {
  SUPABASE_URL: 'PASTE_YOUR_PROJECT_URL_HERE',
  SUPABASE_ANON_KEY: 'PASTE_YOUR_ANON_KEY_HERE',
}
