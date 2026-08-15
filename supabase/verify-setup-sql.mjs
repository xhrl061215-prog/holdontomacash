/**
 * Verifies supabase/SETUP.sql — the single-paste bundle Lily uses in the Supabase
 * SQL editor.
 *
 * The bundle is generated from the migrations, so the risk is not that it is
 * wrong today but that it goes stale: someone adds migration 0009, forgets to
 * regenerate, and the deployment instructions quietly install an older schema
 * than the app expects. That failure appears as a confusing runtime error on
 * someone else's computer, which is the worst place to discover it.
 *
 * So this asserts:
 *   1. the bundle is in sync with the migrations the app actually applies
 *   2. it applies to a fresh database in ONE statement batch
 *   3. the resulting database is correct (brief's lists, one trigger, the RPC)
 *   4. pasting it twice is safe — the likeliest user error
 *
 * Run: node supabase/verify-setup-sql.mjs
 */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ---- 1. the bundle is in sync with the app's migration list ----
const serverSrc = readFileSync(join(root, 'server', 'index.mjs'), 'utf8')
const listed = [
  ...serverSrc.match(/const MIGRATIONS = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+\.sql)'/g),
].map((m) => m[1])

const bundle = readFileSync(join(root, 'supabase', 'SETUP.sql'), 'utf8')

check('SETUP.sql lists every migration the app applies',
  listed.every((f) => bundle.includes(f)),
  listed.filter((f) => !bundle.includes(f)).join(', ') || 'all present')

// Each migration's body must actually be present, not just named in the header.
// Comparing a distinctive line from each file catches a header-only bundle.
for (const f of listed) {
  const src = readFileSync(join(root, 'supabase', 'migrations', f), 'utf8')
  const marker = src
    .split('\n')
    .find((l) => {
      const t = l.trim()
      return t.length > 25 && !t.startsWith('--')
    })
  check(`${f} body is included`, marker != null && bundle.includes(marker.trim()))
}

check('bundle is wrapped in a transaction so a partial apply rolls back',
  /^\s*begin;/m.test(bundle) && /^\s*commit;/m.test(bundle))

// ---- 2 & 3. it applies to a fresh database and produces a correct one ----
const db = await new PGlite()
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
`)

let applied = true
try {
  await db.exec(bundle)
} catch (e) {
  applied = false
  check('SETUP.sql applies to a fresh database in one paste', false, e.message)
}
if (applied) check('SETUP.sql applies to a fresh database in one paste', true)

const BRIEF_EXPENSE = ['Groceries', 'Eating Out', 'Academic', 'Entertainment / Nightlife',
  'Transport', 'Phone / Internet', 'Housing / Living', 'Shopping', 'Health', 'Travel',
  'Subscription', 'Other']
const BRIEF_INCOME = ['Allowance', 'Salary', 'Scholarship', 'Refund', 'Other']
const BRIEF_PM = ['Debit Card', 'Credit Card', 'Global / Travel Card', 'Cash',
  'Bank Transfer', 'Other']

const { rows: [u] } = await db.query(
  `insert into auth.users (email) values ('setup@test.com') returning id`)

const namesOf = async (sql) => (await db.query(sql, [u.id])).rows.map((r) => r.name)
const exp = await namesOf(
  `select name from public.categories where user_id=$1 and type='expense' order by sort_order`)
const inc = await namesOf(
  `select name from public.categories where user_id=$1 and type='income' order by sort_order`)
const pms = await namesOf(
  `select name from public.payment_methods where user_id=$1 order by sort_order`)

check('a new signup gets the brief\'s expense categories, in order',
  JSON.stringify(exp) === JSON.stringify(BRIEF_EXPENSE), exp.join(', '))
check('a new signup gets the brief\'s income categories, in order',
  JSON.stringify(inc) === JSON.stringify(BRIEF_INCOME), inc.join(', '))
check('a new signup gets the brief\'s payment methods, in order',
  JSON.stringify(pms) === JSON.stringify(BRIEF_PM), pms.join(', '))
check('exactly one default payment method',
  (await db.query(
    `select count(*)::int as n from public.payment_methods where user_id=$1 and is_default`,
    [u.id])).rows[0].n === 1)
check('exactly one signup trigger (no double-seeding)',
  (await db.query(
    `select count(*)::int as n from pg_trigger
     where tgrelid='auth.users'::regclass and not tgisinternal`)).rows[0].n === 1)
check('overview_for_month function exists',
  (await db.query(
    `select count(*)::int as n from pg_proc where proname='overview_for_month'`))
    .rows[0].n === 1)
check('row-level security is enabled on every user table',
  (await db.query(
    `select count(*)::int as n from pg_tables t
     join pg_class c on c.relname = t.tablename
     where t.schemaname='public' and c.relrowsecurity
       and t.tablename in ('profiles','categories','payment_methods','transactions')`))
    .rows[0].n === 4)

// ---- 4. pasting it twice is safe ----
let rerun = true
try {
  await db.exec(bundle)
} catch (e) {
  rerun = false
  check('pasting SETUP.sql a second time is safe', false, e.message)
}
if (rerun) check('pasting SETUP.sql a second time is safe', true)

check('no duplicate categories after two applies',
  (await db.query(
    `select count(*)::int as n from (
       select user_id, name, type from public.categories
       group by user_id, name, type having count(*) > 1) d`)).rows[0].n === 0)

console.log(`\n${failures === 0
  ? 'SETUP.sql VERIFIED — safe to paste, in sync with migrations'
  : `${failures} PROBLEM(S) — regenerate with: npm run build:setup-sql`}`)
process.exit(failures === 0 ? 0 : 1)
