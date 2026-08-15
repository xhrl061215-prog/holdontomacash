// Validate the migrations by actually running them on real Postgres (PGlite/WASM).
// PGlite has no auth schema, so we stub the pieces Supabase provides.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const MIG = '/home/user/agent-state/workspace/budget-tracker/supabase/migrations'
const db = await new PGlite()

// --- Stub the Supabase-provided auth surface ---
await db.exec(`
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
  );
  -- current_setting-backed stand-ins for Supabase's auth helpers
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;
`)

for (const f of ['0001_schema.sql', '0002_rls.sql', '0003_handle_new_user.sql',
                 '0004_rate_provenance.sql', '0005_full_precision_conversion.sql',
                 '0006_budget_currency.sql', '0007_seed_brief_lists.sql', '0008_overview_function.sql']) {
  try {
    await db.exec(readFileSync(`${MIG}/${f}`, 'utf8'))
    console.log(`✓ ${f} applied`)
  } catch (e) {
    console.log(`✗ ${f} FAILED: ${e.message}`)
    process.exit(1)
  }
}

// --- Does the signup trigger seed correctly? ---
const { rows: [u1] } = await db.query(
  `insert into auth.users (email) values ('a@test.com') returning id`,
)
const { rows: [u2] } = await db.query(
  `insert into auth.users (email) values ('b@test.com') returning id`,
)

const count = async (t, id) =>
  (await db.query(`select count(*)::int n from ${t} where user_id = $1`, [id])).rows[0].n

console.log('\n-- signup trigger --')
const prof = await db.query('select count(*)::int n from public.profiles')
console.log(`profiles created: ${prof.rows[0].n} (expect 2)`)
console.log(`user1 categories: ${await count('public.categories', u1.id)} (expect 16)`)
console.log(`user1 payment_methods: ${await count('public.payment_methods', u1.id)} (expect 5)`)

const onboarded = await db.query('select onboarded from public.profiles limit 1')
console.log(`onboarded defaults to: ${onboarded.rows[0].onboarded} (expect false)`)

// monthly_budget must accept NULL (optional budget)
const nullBudget = await db.query(
  'select count(*)::int n from public.profiles where monthly_budget is null',
)
console.log(`profiles with null budget: ${nullBudget.rows[0].n} (expect 2 — budget optional)`)

// --- Constraint checks ---
console.log('\n-- constraints --')
const mustFail = async (label, sql, params) => {
  try {
    await db.query(sql, params)
    console.log(`✗ ${label}: allowed but should have been rejected`)
  } catch {
    console.log(`✓ ${label}: correctly rejected`)
  }
}

const cat = (await db.query(
  `select id from public.categories where user_id=$1 and type='expense' limit 1`,
  [u1.id],
)).rows[0]

await mustFail('negative amount', `
  insert into public.transactions
    (user_id, transaction_type, amount, currency, transaction_date, title)
  values ($1,'expense',-5,'KRW','2026-08-15','bad')`, [u1.id])

await mustFail('invalid transaction_type', `
  insert into public.transactions
    (user_id, transaction_type, amount, currency, transaction_date, title)
  values ($1,'transfer',5,'KRW','2026-08-15','bad')`, [u1.id])

await mustFail('duplicate category name+type', `
  insert into public.categories (user_id,name,type) values ($1,'Food','expense')`, [u1.id])

// A valid insert must succeed
const ok = await db.query(`
  insert into public.transactions
    (user_id, transaction_type, amount, currency, transaction_date, category_id, title, description)
  values ($1,'expense',12000,'KRW','2026-08-15',$2,'Lunch','with classmates')
  returning id, amount, currency, converted_amount`, [u1.id, cat.id])
console.log(`✓ valid insert: ${ok.rows[0].amount} ${ok.rows[0].currency}, converted_amount=${ok.rows[0].converted_amount} (expect null in Phase 1)`)

// --- RLS isolation: the real security question ---
console.log('\n-- RLS user isolation --')
await db.exec(`
  create role authenticated;
  grant usage on schema public to authenticated;
  grant all on all tables in schema public to authenticated;
`)

await db.query(`insert into public.transactions
  (user_id, transaction_type, amount, currency, transaction_date, title)
  values ($1,'expense',999,'USD','2026-08-15','user2 private')`, [u2.id])

// Act as user1 with RLS enforced
await db.exec(`set role authenticated`)
await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [u1.id])

const visible = await db.query('select count(*)::int n from public.transactions')
console.log(`user1 sees ${visible.rows[0].n} transaction(s) (expect 1 — only their own)`)

const seenOther = await db.query(
  'select count(*)::int n from public.transactions where user_id = $1', [u2.id])
console.log(`user1 sees user2 rows: ${seenOther.rows[0].n} (expect 0)`)

const catsVisible = await db.query('select count(*)::int n from public.categories')
console.log(`user1 sees ${catsVisible.rows[0].n} categories (expect 16, not 32)`)

// Writing as someone else must be blocked by the WITH CHECK clause
await mustFail('insert row owned by another user', `
  insert into public.transactions
    (user_id, transaction_type, amount, currency, transaction_date, title)
  values ($1,'expense',1,'USD','2026-08-15','spoof')`, [u2.id])

// Cross-user UPDATE/DELETE must be no-ops
const upd = await db.query(
  `update public.transactions set title='hacked' where user_id=$1 returning id`, [u2.id])
console.log(`cross-user UPDATE affected ${upd.rows.length} row(s) (expect 0)`)
const del = await db.query(
  `delete from public.transactions where user_id=$1 returning id`, [u2.id])
console.log(`cross-user DELETE affected ${del.rows.length} row(s) (expect 0)`)

const profVisible = await db.query('select count(*)::int n from public.profiles')
console.log(`user1 sees ${profVisible.rows[0].n} profile(s) (expect 1)`)

await db.exec('reset role')
console.log('\nAll migration checks completed.')
