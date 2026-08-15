/**
 * Cross-checks the hosted overview SQL function against the preview backend's
 * JS implementation.
 *
 * The hosted deployment cannot run server/overview.mjs, so 0008 reimplements the
 * aggregation in Postgres. Two implementations of the same money maths is exactly
 * the situation where they drift and one of them starts lying.
 *
 * So this asserts the SQL function's properties directly on real Postgres:
 * exact numeric sums, NULL conversions excluded rather than counted as zero,
 * string month bucketing, budget converted from its own currency, and the
 * comparison suppressed when no rate exists.
 *
 * Run: node supabase/verify-overview-function.mjs
 */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIG = dirname(fileURLToPath(import.meta.url)) + '/migrations'
const read = (f) => readFileSync(join(MIG, f), 'utf8')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const db = await new PGlite()
// Supabase provides these roles; PGlite does not, so create them for the grant
// statements in 0008 to resolve.
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role;
    end if;
  end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
`)

for (const f of [
  '0001_schema.sql', '0002_rls.sql', '0003_handle_new_user.sql',
  '0004_rate_provenance.sql', '0005_full_precision_conversion.sql',
  '0006_budget_currency.sql', '0007_seed_brief_lists.sql',
  '0008_overview_function.sql',
]) {
  await db.exec(read(f))
}
// RLS is not enforced for superusers. The harness must genuinely assume the
// authenticated role, or the isolation assertions below prove nothing.
await db.exec(`
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  -- Supabase grants these; PGlite does not. auth.uid() must be callable by the
  -- role, or every policy errors instead of filtering.
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant execute on function auth.role() to authenticated;
  grant select on auth.users to authenticated;
`)
console.log('Applied 0001..0008\n')

const { rows: [user] } = await db.query(
  `insert into auth.users (email) values ('ov@test.com') returning id`)

// Act as this user for every call, so RLS is genuinely in force.
const asUser = async (sql, params = []) => {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user.id])
  await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
  await db.exec('set role authenticated')   // RLS applies only to non-superusers
  const out = await db.query(sql, params)
  await db.exec('reset role')
  return out
}

const month = new Date().toISOString().slice(0, 7)
const cat = async (name, type = 'expense') =>
  (await asUser(
    `select id from public.categories where user_id=$1 and name=$2 and type=$3`,
    [user.id, name, type])).rows[0].id

const groceries = await cat('Groceries')
const transport = await cat('Transport')

const addTx = async (o) => {
  await asUser(
    `insert into public.transactions
       (user_id, transaction_type, amount, currency, transaction_date, category_id,
        title, converted_amount, converted_currency, exchange_rate, rate_date,
        rate_is_approximate)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [user.id, o.type, o.amount, o.currency, o.date, o.category, o.title,
     o.converted ?? null, o.convertedCurrency ?? null, o.rate ?? null,
     o.rateDate ?? null, o.approximate ?? false])
}

const overview = async (m = month) =>
  (await asUser(`select public.overview_for_month($1) as o`, [m])).rows[0].o

// ---- profile: GBP local, KRW home, GBP1500 budget ----
await asUser(
  `update public.profiles set study_country='GB', local_currency='GBP',
     home_currency='KRW', display_currency='KRW', monthly_budget=1500,
     budget_currency='GBP', onboarded=true where id=$1`, [user.id])

console.log('=== exact numeric aggregation ===\n')

// Values chosen so binary float would visibly drift.
await addTx({ type: 'expense', amount: '0.10', currency: 'GBP', date: `${month}-01`,
  category: groceries, title: 'a', converted: '186.70', convertedCurrency: 'KRW',
  rate: '1867.00000000', rateDate: `${month}-01` })
await addTx({ type: 'expense', amount: '0.20', currency: 'GBP', date: `${month}-02`,
  category: groceries, title: 'b', converted: '373.40', convertedCurrency: 'KRW',
  rate: '1867.00000000', rateDate: `${month}-02` })
await addTx({ type: 'expense', amount: '0.30', currency: 'GBP', date: `${month}-03`,
  category: transport, title: 'c', converted: '560.10', convertedCurrency: 'KRW',
  rate: '1867.00000000', rateDate: `${month}-03` })

let ov = await overview()
// 186.70 + 373.40 + 560.10 = 1120.20 exactly. JS float gives 1120.1999999999998.
check('sums are exact decimal, not float', Number(ov.totals.expense) === 1120.2
  && !String(ov.totals.expense).includes('19999'), ov.totals.expense)
check('net is income minus expense', Number(ov.totals.net) === -1120.2, ov.totals.net)

console.log('\n=== NULL conversions excluded, not counted as zero ===\n')

await addTx({ type: 'expense', amount: '99.99', currency: 'GBP', date: `${month}-04`,
  category: groceries, title: 'pending' }) // no converted_amount

ov = await overview()
check('a pending row does not change the total', Number(ov.totals.expense) === 1120.2,
  ov.totals.expense)
check('a pending row is reported, not hidden', ov.flags.pending_count === 1,
  `pending_count=${ov.flags.pending_count}`)
const names = ov.categories.map((c) => c.category_name)
check('a pending row contributes no zero-value category row',
  ov.categories.every((c) => Number(c.total) > 0), names.join(', '))

console.log('\n=== budget converted from its own currency ===\n')

check('budget_original preserves what the user typed',
  Number(ov.totals.budget_original) === 1500, ov.totals.budget_original)
check('budget_currency is the local currency', ov.totals.budget_currency === 'GBP',
  ov.totals.budget_currency)
check('budget was converted', ov.totals.budget_converted === true)
// 1500 * 1867 = 2,800,500
check('budget in home currency uses the stored rate',
  Number(ov.totals.monthly_budget) === 2800500, ov.totals.monthly_budget)
const pct = (Number(ov.totals.expense) / Number(ov.totals.monthly_budget)) * 100
check('budget percentage is plausible, not a unit error', pct < 1000,
  `${pct.toFixed(4)}%`)
check('remaining is budget minus spend',
  Number(ov.totals.budget_remaining) === 2800500 - 1120.2, ov.totals.budget_remaining)

console.log('\n=== comparison is suppressed when no rate exists ===\n')

const { rows: [u2] } = await db.query(
  `insert into auth.users (email) values ('norate@test.com') returning id`)
const asU2 = async (sql, params = []) => {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [u2.id])
  await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
  await db.exec('set role authenticated')
  const out = await db.query(sql, params)
  await db.exec('reset role')
  return out
}
await asU2(
  `update public.profiles set local_currency='JPY', home_currency='BRL',
     display_currency='BRL', monthly_budget=150000, budget_currency='JPY',
     onboarded=true where id=$1`, [u2.id])
const ov2 = (await asU2(`select public.overview_for_month($1) as o`, [month])).rows[0].o
check('no rate available means no budget comparison', ov2.totals.monthly_budget === null,
  String(ov2.totals.monthly_budget))
check('the missing basis is reported, not silently zero',
  ov2.totals.budget_basis_unknown === true)
check('budget_original is still shown so the figure is not lost',
  Number(ov2.totals.budget_original) === 150000, ov2.totals.budget_original)

console.log('\n=== month bucketing by string, not timestamp ===\n')

// A last-day-of-month transaction must not leak into the next month for a user
// east of UTC. Only string comparison guarantees this.
const [yy, mm] = month.split('-').map(Number)
const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
await addTx({ type: 'expense', amount: '1.00', currency: 'GBP',
  date: `${month}-${lastDay}`, category: groceries, title: 'last day',
  converted: '1867.00', convertedCurrency: 'KRW', rate: '1867.00000000',
  rateDate: `${month}-${lastDay}` })
ov = await overview()
check('a last-day transaction lands in this month',
  Number(ov.totals.expense) === 1120.2 + 1867, ov.totals.expense)
const nextMonth = mm === 12 ? `${yy + 1}-01` : `${yy}-${String(mm + 1).padStart(2, '0')}`
const ovNext = await overview(nextMonth)
check('and not in the next month', Number(ovNext.totals.expense) === 0,
  ovNext.totals.expense)

console.log('\n=== RLS: the function cannot read another user\'s rows ===\n')

const ovAsU2 = (await asU2(`select public.overview_for_month($1) as o`, [month])).rows[0].o
check('user 2 sees none of user 1\'s spending', Number(ovAsU2.totals.expense) === 0,
  ovAsU2.totals.expense)

console.log('\n=== input validation ===\n')
for (const bad of ['2026-13', 'not-a-month', '2026-00', "2026-01'; drop table public.transactions; --"]) {
  let rejected = false
  try { await overview(bad) } catch { rejected = true }
  check(`rejects malformed month ${JSON.stringify(bad.slice(0, 24))}`, rejected)
}
const survives = (await db.query(`select count(*)::int as n from public.transactions`)).rows[0].n
check('transactions table survived the injection attempt', survives > 0, `${survives} rows`)

console.log(`\n${failures === 0
  ? 'HOSTED OVERVIEW FUNCTION VERIFIED'
  : `${failures} PROBLEM(S)`}`)
process.exit(failures === 0 ? 0 : 1)
