/**
 * Verifies migration 0007 (seed the brief's lists) behaves correctly on a
 * database that already contains the OLD seed data and real transactions.
 *
 * The risk in a data-correcting migration is destroying user data. This runs the
 * old seed, files transactions against invented categories, then applies 0007
 * and asserts:
 *   - the brief's entries are all present afterwards
 *   - an invented category WITH transactions survives (it is the user's data now)
 *   - an invented category WITHOUT transactions is removed
 *   - no transaction loses its category or payment method
 *   - every user still has exactly one default payment method
 *
 * Uses real Postgres via PGlite. Run: node supabase/verify-seed-migration.mjs
 */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIG = dirname(fileURLToPath(import.meta.url)) + '/migrations'
const read = (f) => readFileSync(join(MIG, f), 'utf8')

const db = await new PGlite()
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Supabase-provided surface.
await db.exec(`
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
`)

// Schema + the ORIGINAL seed trigger, i.e. the state before this fix.
for (const f of [
  '0001_schema.sql', '0002_rls.sql', '0003_handle_new_user.sql',
  '0004_rate_provenance.sql', '0005_full_precision_conversion.sql',
  '0006_budget_currency.sql',
]) {
  await db.exec(read(f))
}
console.log('Applied schema with the ORIGINAL seed lists\n')

// Two users seeded the old way.
const { rows: [u1] } = await db.query(
  `insert into auth.users (email) values ('old1@test.com') returning id`)
const { rows: [u2] } = await db.query(
  `insert into auth.users (email) values ('old2@test.com') returning id`)

const before = await db.query(
  `select name from public.categories where user_id=$1 and type='expense' order by sort_order`,
  [u1.id])
console.log('old expense list:', before.rows.map((r) => r.name).join(', '), '\n')

// u1 files transactions against two INVENTED categories and the invented
// payment method, so the migration must preserve them.
const pick = async (name, type) =>
  (await db.query(
    `select id from public.categories where user_id=$1 and name=$2 and type=$3`,
    [u1.id, name, type])).rows[0]
const pickPm = async (name) =>
  (await db.query(`select id from public.payment_methods where user_id=$1 and name=$2`,
    [u1.id, name])).rows[0]

const utilities = await pick('Utilities', 'expense')
const food = await pick('Food', 'expense')
const education = await pick('Education', 'expense')
const mobilePay = await pickPm('Mobile Payment')

for (const [cat, pm, title] of [
  [utilities.id, mobilePay.id, 'Electric bill'],
  [food.id, mobilePay.id, 'Lunch'],
]) {
  await db.query(
    `insert into public.transactions
       (user_id, transaction_type, amount, currency, transaction_date,
        category_id, payment_method_id, title)
     values ($1,'expense',10,'GBP','2026-08-01',$2,$3,$4)`,
    [u1.id, cat, pm, title])
}
// Education is left UNUSED, so it should be cleaned up.
console.log('u1 has transactions against Utilities and Food (invented), none against Education\n')

// ---- apply the fix ----
await db.exec(read('0007_seed_brief_lists.sql'))
console.log('Applied 0007_seed_brief_lists.sql\n')

// ---- 1. the brief's entries exist for both users ----
const BRIEF_EXPENSE = ['Groceries', 'Eating Out', 'Academic', 'Entertainment / Nightlife',
  'Transport', 'Phone / Internet', 'Housing / Living', 'Shopping', 'Health', 'Travel',
  'Subscription', 'Other']
const BRIEF_INCOME = ['Allowance', 'Salary', 'Scholarship', 'Refund', 'Other']
const BRIEF_PM = ['Debit Card', 'Credit Card', 'Global / Travel Card', 'Cash',
  'Bank Transfer', 'Other']

for (const [label, userId] of [['existing user u1', u1.id], ['existing user u2', u2.id]]) {
  const exp = (await db.query(
    `select name from public.categories where user_id=$1 and type='expense'`, [userId]))
    .rows.map((r) => r.name)
  const inc = (await db.query(
    `select name from public.categories where user_id=$1 and type='income'`, [userId]))
    .rows.map((r) => r.name)
  const pms = (await db.query(
    `select name from public.payment_methods where user_id=$1`, [userId]))
    .rows.map((r) => r.name)

  check(`${label}: all brief expense categories present`,
    BRIEF_EXPENSE.every((n) => exp.includes(n)),
    BRIEF_EXPENSE.filter((n) => !exp.includes(n)).join(', ') || 'all present')
  check(`${label}: all brief income categories present`,
    BRIEF_INCOME.every((n) => inc.includes(n)),
    BRIEF_INCOME.filter((n) => !inc.includes(n)).join(', ') || 'all present')
  check(`${label}: all brief payment methods present`,
    BRIEF_PM.every((n) => pms.includes(n)),
    BRIEF_PM.filter((n) => !pms.includes(n)).join(', ') || 'all present')
}

// ---- 2. used invented entries survive; unused ones are removed ----
const stillThere = async (name, userId) =>
  (await db.query(
    `select 1 from public.categories where user_id=$1 and name=$2`, [userId, name]))
    .rows.length > 0

check('invented category WITH transactions survives (Utilities)',
  await stillThere('Utilities', u1.id))
check('invented category WITH transactions survives (Food)',
  await stillThere('Food', u1.id))
check('unused invented category is removed (Education)',
  !(await stillThere('Education', u1.id)))
check('unused invented categories removed for untouched user (u2 Utilities)',
  !(await stillThere('Utilities', u2.id)))

const pmStill = (await db.query(
  `select 1 from public.payment_methods where user_id=$1 and name='Mobile Payment'`,
  [u1.id])).rows.length > 0
check('invented payment method WITH transactions survives (Mobile Payment)', pmStill)
const pmGone = (await db.query(
  `select 1 from public.payment_methods where user_id=$1 and name='Mobile Payment'`,
  [u2.id])).rows.length === 0
check('unused invented payment method removed (u2 Mobile Payment)', pmGone)

// ---- 3. no transaction lost its references ----
const orphaned = (await db.query(
  `select count(*)::int as n from public.transactions
   where category_id is null or payment_method_id is null`)).rows[0].n
check('no transaction lost its category or payment method', orphaned === 0,
  `${orphaned} orphaned`)

const txCount = (await db.query(
  `select count(*)::int as n from public.transactions`)).rows[0].n
check('all transactions still present', txCount === 2, `${txCount} rows`)

// ---- 4. exactly one default payment method per user ----
for (const [label, userId] of [['u1', u1.id], ['u2', u2.id]]) {
  const n = (await db.query(
    `select count(*)::int as n from public.payment_methods
     where user_id=$1 and is_default`, [userId])).rows[0].n
  check(`${label} has exactly one default payment method`, n === 1, `${n} defaults`)
}

// ---- 5. a NEW user gets the brief's lists in the brief's order ----
const { rows: [u3] } = await db.query(
  `insert into auth.users (email) values ('new@test.com') returning id`)
const newExp = (await db.query(
  `select name from public.categories where user_id=$1 and type='expense' order by sort_order`,
  [u3.id])).rows.map((r) => r.name)
const newInc = (await db.query(
  `select name from public.categories where user_id=$1 and type='income' order by sort_order`,
  [u3.id])).rows.map((r) => r.name)
const newPm = (await db.query(
  `select name from public.payment_methods where user_id=$1 order by sort_order`,
  [u3.id])).rows.map((r) => r.name)

check('new user expense list matches the brief exactly, in order',
  JSON.stringify(newExp) === JSON.stringify(BRIEF_EXPENSE), newExp.join(', '))
check('new user income list matches the brief exactly, in order',
  JSON.stringify(newInc) === JSON.stringify(BRIEF_INCOME), newInc.join(', '))
check('new user payment methods match the brief exactly, in order',
  JSON.stringify(newPm) === JSON.stringify(BRIEF_PM), newPm.join(', '))
check('new user has no invented entries',
  !newExp.some((n) => ['Food', 'Utilities', 'Education', 'Entertainment', 'Housing',
    'Phone & Internet'].includes(n)))

// ---- 6. exactly one signup trigger, so nobody is seeded twice ----
// 0003 and 0007 both define handle_new_user and the trigger. If 0003's trigger
// survived alongside 0007's, every new user would be seeded twice.
const triggers = (await db.query(
  `select count(*)::int as n from pg_trigger
   where tgrelid = 'auth.users'::regclass and not tgisinternal`)).rows[0].n
check('exactly one signup trigger on auth.users (no double seeding)',
  triggers === 1, `${triggers} triggers`)

// ---- 7. re-running the migration is safe ----
await db.exec(read('0007_seed_brief_lists.sql'))
const dupes = (await db.query(
  `select count(*)::int as n from (
     select user_id, name, type from public.categories
     group by user_id, name, type having count(*) > 1
   ) d`)).rows[0].n
check('re-running the migration creates no duplicates', dupes === 0, `${dupes} duplicated`)

console.log(`\n${failures === 0 ? 'SEED MIGRATION SAFE' : `${failures} PROBLEM(S)`}`)
process.exit(failures === 0 ? 0 : 1)
