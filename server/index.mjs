/**
 * Local auth + data API for the Phase 1 preview.
 *
 * Why this exists: provisioning a hosted Supabase project needs an account with
 * email verification, which I cannot complete from the sandbox. Rather than
 * hand over an untestable link, this runs a REAL Postgres (PGlite/WASM) and
 * applies the EXACT SAME migrations and RLS policies from
 * supabase/migrations/ that a Supabase project would.
 *
 * The security model under test is therefore genuine: every request sets
 * request.jwt.claim.sub and runs as the `authenticated` role, so Postgres RLS
 * (not this file) decides what each user can see. Swapping in hosted Supabase
 * is a URL/key change, not a rewrite.
 *
 * Not production: tokens are opaque random strings in memory and passwords are
 * salted+hashed with scrypt. Good enough for a preview, not a deployment.
 */
import express from 'express'
import { PGlite, types } from '@electric-sql/pglite'
import { buildConversion, decimalsFor as currencyDecimals, getRate, rateToNumericString } from './currency.mjs'
import {
  aggregateWindow, equalPeriodBounds, dayBound, daysInMonth, previousMonth,
} from './overview.mjs'
import { buildInsights } from './consultant.mjs'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIG = join(__dirname, '..', 'supabase', 'migrations')
const DATA_DIR = join(__dirname, '..', '.data')

/**
 * `transaction_date` is a Postgres DATE — a calendar day with no time and no
 * timezone. The driver's default parser turns it into a JS Date, which
 * JSON-serialises to "2026-08-15T00:00:00.000Z"; any client then reading that
 * with `new Date(...)` in a timezone west of UTC gets the PREVIOUS day, so a
 * 1st-of-month transaction misfiles into the previous month's bucket.
 *
 * Keep DATE as the bare YYYY-MM-DD string it is in the database. Timestamp
 * columns (created_at/updated_at) are genuine instants and keep default
 * parsing.
 */
const DATE_AS_STRING = { [types.DATE]: (v) => v }

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

// Persist to disk so data survives a restart — "log out, log back in, still
// see it" has to hold across process restarts, not just within one.
const db = await new PGlite(join(DATA_DIR, 'pgdata'))

const MIGRATIONS = [
  '0001_schema.sql',
  '0002_rls.sql',
  '0003_handle_new_user.sql',
  '0004_rate_provenance.sql',
  '0005_full_precision_conversion.sql',
  '0006_budget_currency.sql',
  '0007_seed_brief_lists.sql',
  '0008_overview_function.sql',
]

/**
 * Apply every migration, tracking which have run in schema_migrations.
 * Idempotent, so an existing database picks up new migrations on restart
 * instead of silently running an old schema.
 */
async function applyMigrations() {
  await db.exec(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `)
  const { rows } = await db.query(`select filename from public.schema_migrations`)
  const done = new Set(rows.map((r) => r.filename))

  for (const f of MIGRATIONS) {
    if (done.has(f)) continue
    await db.exec(readFileSync(join(MIG, f), 'utf8'))
    await db.query(`insert into public.schema_migrations (filename) values ($1)`, [f])
    console.log(`[db] applied ${f}`)
  }
}

const alreadyInitialised = await db
  .query(`select 1 from information_schema.tables where table_name='profiles'`)
  .then((r) => r.rows.length > 0)
  .catch(() => false)

if (!alreadyInitialised) {
  // Stub only what Supabase itself provides: the auth schema and helpers.
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
    $$;
  `)

  await applyMigrations()

  await db.exec(`
    create role authenticated;
    grant usage on schema public to authenticated;
    grant all on all tables in schema public to authenticated;
  `)
  console.log('[db] initialised')
} else {
  console.log('[db] reusing existing database')
  // Pick up any migrations added since this database was created.
  await applyMigrations()
}

// ---- password hashing ----
const hashPassword = (pw) => {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`
}
const verifyPassword = (pw, stored) => {
  const [salt, key] = stored.split(':')
  const a = Buffer.from(key, 'hex')
  const b = scryptSync(pw, salt, 64)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---- sessions ----
const sessions = new Map() // token -> userId

/**
 * Run a callback with RLS enforced as `userId`. Postgres decides access.
 * Serialised because PGlite is a single connection and the role/claim are
 * session state.
 */
let queue = Promise.resolve()
function asUser(userId, fn) {
  const run = async () => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId])
    await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
    await db.exec(`set role authenticated`)
    try {
      return await fn()
    } finally {
      await db.exec(`reset role`)
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => {})
  return result
}

const app = express()
app.use(express.json())

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  const userId = sessions.get(token)
  if (!userId) return res.status(401).json({ error: 'Not authenticated' })
  req.userId = userId
  next()
}

// ---- auth ----
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

  try {
    const { rows } = await db.query(
      `insert into auth.users (email, password_hash) values ($1,$2) returning id, email`,
      [String(email).toLowerCase().trim(), hashPassword(String(password))],
    )
    const user = rows[0]
    const token = randomBytes(32).toString('hex')
    sessions.set(token, user.id)
    res.json({ token, user })
  } catch (e) {
    if (String(e.message).includes('duplicate') || String(e.message).includes('unique')) {
      return res.status(400).json({ error: 'An account with this email already exists' })
    }
    res.status(500).json({ error: e.message })
  }
})

app.post('/auth/signin', async (req, res) => {
  const { email, password } = req.body ?? {}
  const { rows } = await db.query(`select * from auth.users where email = $1`, [
    String(email ?? '').toLowerCase().trim(),
  ])
  const user = rows[0]
  if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
    return res.status(400).json({ error: 'Invalid email or password' })
  }
  const token = randomBytes(32).toString('hex')
  sessions.set(token, user.id)
  res.json({ token, user: { id: user.id, email: user.email } })
})

app.post('/auth/signout', auth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''))
  res.json({ ok: true })
})

app.get('/auth/me', auth, async (req, res) => {
  const { rows } = await db.query(`select id, email from auth.users where id = $1`, [req.userId])
  res.json({ user: rows[0] ?? null })
})

// ---- data (all RLS-enforced) ----
app.get('/api/profile', auth, async (req, res) => {
  try {
    const { rows } = await asUser(req.userId, () =>
      db.query(`select * from public.profiles`),
    )
    res.json({ profile: rows[0] ?? null })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/profile', auth, async (req, res) => {
  const {
    study_country, local_currency, home_currency, display_currency,
    monthly_budget, budget_currency, onboarded,
  } = req.body ?? {}
  try {
    // The budget is denominated in the LOCAL spending currency — what a student
    // thinks in when setting it. Snapshot it, so later changing local_currency
    // cannot silently re-denominate an existing budget (same reasoning as
    // transactions.converted_currency).
    const budget = monthly_budget ?? null
    const budgetCurrency =
      budget === null ? null : (budget_currency ?? local_currency ?? null)

    if (budget !== null) {
      // Validate against the budget's own currency, not the home currency.
      amountToNumericString(budget, budgetCurrency ?? 'USD')
    }

    const { rows } = await asUser(req.userId, () =>
      db.query(
        `update public.profiles set
           study_country=$1, local_currency=$2, home_currency=$3,
           display_currency=$4, monthly_budget=$5, budget_currency=$6, onboarded=$7
         where id=$8 returning *`,
        [study_country, local_currency, home_currency, display_currency,
         budget, budgetCurrency, onboarded ?? false, req.userId],
      ),
    )
    res.json({ profile: rows[0] ?? null })
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : 500
    res.status(status).json({ error: e.message })
  }
})

app.get('/api/categories', auth, async (req, res) => {
  const { rows } = await asUser(req.userId, () =>
    db.query(`select * from public.categories order by sort_order`),
  )
  res.json({ categories: rows })
})

app.get('/api/payment-methods', auth, async (req, res) => {
  const { rows } = await asUser(req.userId, () =>
    db.query(`select * from public.payment_methods order by sort_order`),
  )
  res.json({ payment_methods: rows })
})

/**
 * List transactions with server-side filtering, search and sort.
 * Filtering in SQL (not the client) so this holds up at thousands of rows.
 *
 * Query params: month=YYYY-MM, category_id, payment_method_id, currency,
 *   type=expense|income, q=<text>, sort=date_asc|date_desc, limit, offset
 */
const TRANSACTION_QUERY_PARAMS = new Set([
  'month', 'category_id', 'payment_method_id', 'currency', 'type', 'q',
  'sort', 'limit', 'offset',
])

app.get('/api/transactions', auth, async (req, res) => {
  // Reject unknown params rather than ignoring them: a typo'd filter that
  // silently returns everything is worse than an error, because the caller
  // believes they are looking at a filtered list.
  const unknown = Object.keys(req.query).filter((k) => !TRANSACTION_QUERY_PARAMS.has(k))
  if (unknown.length > 0) {
    return res.status(400).json({
      error: `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Supported: ${[...TRANSACTION_QUERY_PARAMS].join(', ')}`,
    })
  }

  const { month, category_id, payment_method_id, currency, type, q } = req.query
  const sort = req.query.sort === 'date_asc' ? 'asc' : 'desc'
  const limit = Math.min(Number(req.query.limit) || 500, 1000)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const where = []
  const params = []
  const add = (clause, value) => {
    params.push(value)
    where.push(clause.replace('?', `$${params.length}`))
  }

  // RLS already scopes to the caller; these are user-chosen filters.
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    // String comparison on a DATE column via to_char keeps this timezone-free.
    add("to_char(t.transaction_date, 'YYYY-MM') = ?", month)
  }
  if (category_id) add('t.category_id = ?', category_id)
  if (payment_method_id) add('t.payment_method_id = ?', payment_method_id)
  if (currency) add('t.currency = ?', String(currency).toUpperCase())
  if (type === 'expense' || type === 'income') add('t.transaction_type = ?', type)
  if (q && String(q).trim()) {
    // Case-insensitive substring across title AND description, one bound param
    // referenced twice.
    params.push(`%${String(q).trim()}%`)
    const i = params.length
    where.push(`(t.title ilike $${i} or coalesce(t.description,'') ilike $${i})`)
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : ''

  try {
    const { rows } = await asUser(req.userId, () =>
      db.query(
        `select t.*, c.name as category_name, c.type as category_type,
                p.name as payment_method_name
         from public.transactions t
         left join public.categories c on c.id = t.category_id
         left join public.payment_methods p on p.id = t.payment_method_id
         ${whereSql}
         order by t.transaction_date ${sort}, t.created_at ${sort}
         limit ${limit} offset ${offset}`,
        params,
        { parsers: DATE_AS_STRING },
      ),
    )
    const { rows: countRows } = await asUser(req.userId, () =>
      db.query(
        `select count(*)::int as n from public.transactions t ${whereSql}`,
        params,
      ),
    )
    res.json({ transactions: rows, total: countRows[0]?.n ?? rows.length })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** Distinct currencies actually used — powers the currency filter options. */
app.get('/api/transactions/currencies', auth, async (req, res) => {
  const { rows } = await asUser(req.userId, () =>
    db.query(`select distinct currency from public.transactions order by currency`),
  )
  res.json({ currencies: rows.map((r) => r.currency) })
})

/** Months that actually have transactions — powers the month filter options. */
app.get('/api/transactions/months', auth, async (req, res) => {
  const { rows } = await asUser(req.userId, () =>
    db.query(
      `select distinct to_char(transaction_date, 'YYYY-MM') as month
       from public.transactions order by month desc`,
    ),
  )
  res.json({ months: rows.map((r) => r.month) })
})

/**
 * Render a user-supplied amount as an exact decimal string for Postgres.
 * Never routed through JS `Number` arithmetic — only validated and normalised —
 * so no binary-float error can enter the money path.
 */
class ValidationError extends Error {}

/** amount is numeric(18,2) -> 18 total digits minus 2 decimals = 16 integer digits. */
const MAX_AMOUNT_INTEGER_DIGITS = 16

/** Today as YYYY-MM-DD from local parts — never toISOString, which shifts. */
function currentDateString() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function currentMonthString() {
  return currentDateString().slice(0, 7)
}

/**
 * Exact decimal multiplication on strings — money never touches JS floats.
 */
function multiplyDecimalStrings(a, b) {
  const parse = (v) => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v ?? '0').trim())
    if (!m) return [0n, 0]
    const [, sign, int, frac = ''] = m
    const val = BigInt(int + frac)
    return [sign === '-' ? -val : val, frac.length]
  }
  const [av, as] = parse(a)
  const [bv, bs] = parse(b)
  const product = av * bv
  const scale = as + bs
  const neg = product < 0n
  const digits = (neg ? -product : product).toString().padStart(scale + 1, '0')
  let out =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return (neg ? '-' : '') + (out || '0')
}

/**
 * Exact decimal subtraction on strings. Money never goes through JS floats, so
 * derived figures (net income, budget remaining) are computed on BigInts.
 */
function subtractDecimalStrings(a, b) {
  const parse = (v) => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v ?? '0').trim())
    if (!m) return [0n, 0]
    const [, sign, int, frac = ''] = m
    const val = BigInt(int + frac)
    return [sign === '-' ? -val : val, frac.length]
  }
  const [av, as] = parse(a)
  const [bv, bs] = parse(b)
  const scale = Math.max(as, bs)
  const diff = av * 10n ** BigInt(scale - as) - bv * 10n ** BigInt(scale - bs)
  const neg = diff < 0n
  const digits = (neg ? -diff : diff).toString().padStart(scale + 1, '0')
  let out =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return (neg ? '-' : '') + (out || '0')
}

/**
 * Numeric equality for two plain decimal strings, without float arithmetic.
 * "2.50" and "2.5" are equal; comparison is done on scaled BigInts.
 */
function decimalStringsEqual(a, b) {
  const parse = (v) => {
    const [int, frac = ''] = String(v).trim().split('.')
    return [BigInt(int + frac), frac.length]
  }
  const [av, as] = parse(a)
  const [bv, bs] = parse(b)
  const scale = Math.max(as, bs)
  return av * 10n ** BigInt(scale - as) === bv * 10n ** BigInt(scale - bs)
}

/**
 * Validate a submitted amount and return THE canonical decimal string that
 * feeds BOTH storage and conversion.
 *
 * There must be exactly one canonical amount. The earlier bug: `amount` is
 * `numeric(18,2)` so Postgres rounded 2.675 -> 2.68 on write, while the
 * conversion multiplied the raw 2.675. The stored row was then internally
 * inconsistent — `converted != amount * rate` by its own values — and
 * `converted / rate` leaked the unrounded basis.
 *
 * Rather than silently normalise a number the user typed, more decimals than
 * the currency supports is rejected. Quietly altering someone's figure in a
 * finance tool is worse than telling them.
 *
 * `currency` is required so the limit matches the currency: KRW/JPY have no
 * minor unit, so 0.5 KRW is not a real amount.
 */
function amountToNumericString(value, currency) {
  const s = String(value).trim()

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new ValidationError(
      'Amount must be a positive number using digits and at most one decimal point.',
    )
  }

  // Check zero BEFORE the decimals rule, so "0.00" reports the real problem
  // (no value) rather than a misleading complaint about decimal places.
  // Matches any run of zeros with an optional zero fraction, so "00" and "0.0"
  // are caught too — "00" previously slipped through and stored 0.00.
  if (/^0+(\.0*)?$/.test(s)) {
    throw new ValidationError('Amount must be greater than 0.')
  }

  const maxDecimals = currencyDecimals(currency)
  const [, fraction = ''] = s.split('.')
  if (fraction.length > maxDecimals) {
    throw new ValidationError(
      maxDecimals === 0
        ? `${String(currency).toUpperCase()} has no decimal unit — enter a whole number.`
        : `Amount for ${String(currency).toUpperCase()} supports at most ${maxDecimals} decimal places.`,
    )
  }

  // Strip redundant leading zeros so the canonical form is unambiguous
  // ("007.50" -> "7.50"); the value is unchanged.
  const canonical = s.replace(/^0+(?=\d)/, '')

  // amount is numeric(18,2): 18 total digits, 2 after the point, so 16 before
  // it. Check here rather than letting Postgres raise "numeric field overflow",
  // which leaks internals and never says what the limit is.
  const [integerPart] = canonical.split('.')
  if (integerPart.length > MAX_AMOUNT_INTEGER_DIGITS) {
    throw new ValidationError(
      `Amount is too large — the maximum is ${MAX_AMOUNT_INTEGER_DIGITS} digits ` +
        `before the decimal point.`,
    )
  }

  return canonical
}

async function homeCurrencyFor(userId) {
  const { rows } = await asUser(userId, () =>
    db.query(`select home_currency from public.profiles where id = $1`, [userId]),
  )
  return rows[0]?.home_currency ?? null
}

app.post('/api/transactions', auth, async (req, res) => {
  const {
    transaction_type, amount, currency, transaction_date,
    category_id, title, description, payment_method_id,
  } = req.body ?? {}

  try {
    // Snapshot the home currency at write time so later profile changes never
    // mutate historical rows.
    const home = await homeCurrencyFor(req.userId)
    const amountStr = amountToNumericString(amount, currency)
    const conv = home
      ? await buildConversion(amountStr, currency, transaction_date, home)
      : {
          exchange_rate: null, converted_currency: null,
          rate_date: null, rate_source: null, rate_is_approximate: false,
        }

    // converted_amount is computed by Postgres as numeric ($3 * $10), never in
    // JS — `20.00 * 1910.38` in binary float is 38207.600000000006, and the
    // unscaled numeric column would faithfully store that error.
    const { rows } = await asUser(req.userId, () =>
      db.query(
        `insert into public.transactions
           (user_id, transaction_type, amount, currency, transaction_date,
            category_id, title, description, payment_method_id,
            exchange_rate, converted_amount, converted_currency,
            rate_date, rate_source, rate_is_approximate)
         values ($1,$2,$3::numeric,$4,$5,$6,$7,$8,$9,$10::numeric,
                 $3::numeric * $10::numeric,$11,$12,$13,$14)
         returning *`,
        [
          req.userId, transaction_type, amountStr, currency, transaction_date,
          category_id || null, title, description || null, payment_method_id || null,
          conv.exchange_rate, conv.converted_currency,
          conv.rate_date, conv.rate_source, conv.rate_is_approximate,
        ],
        { parsers: DATE_AS_STRING },
      ),
    )
    res.json({ transaction: rows[0] })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Update a transaction. Changing amount, currency or date RE-RUNS conversion —
 * a stale rate on an edited row is a silently wrong number.
 * RLS scopes the update, so another user's row simply matches nothing.
 */
app.patch('/api/transactions/:id', auth, async (req, res) => {
  const { id } = req.params
  const {
    transaction_type, amount, currency, transaction_date,
    category_id, title, description, payment_method_id,
  } = req.body ?? {}

  try {
    const { rows: existingRows } = await asUser(req.userId, () =>
      db.query(`select * from public.transactions where id = $1`, [id], {
        parsers: DATE_AS_STRING,
      }),
    )
    const existing = existingRows[0]
    // Not found OR not ours — RLS makes these indistinguishable, which is right.
    if (!existing) return res.status(404).json({ error: 'Transaction not found' })

    const next = {
      transaction_type: transaction_type ?? existing.transaction_type,
      amount: amount ?? existing.amount,
      currency: currency ?? existing.currency,
      transaction_date: transaction_date ?? existing.transaction_date,
      category_id: category_id !== undefined ? category_id : existing.category_id,
      title: title ?? existing.title,
      description: description !== undefined ? description : existing.description,
      payment_method_id:
        payment_method_id !== undefined ? payment_method_id : existing.payment_method_id,
    }

    // Validate against the row's NEW currency — switching KRW->GBP changes how
    // many decimals are permissible.
    const nextAmountStr = amountToNumericString(next.amount, next.currency)

    // Compare as exact decimal strings, never via Number. `existing.amount`
    // comes from the DB already canonical, so compare numerically-equal decimals
    // rather than requiring identical text ("2.50" vs "2.5").
    const moneyChanged =
      !decimalStringsEqual(nextAmountStr, String(existing.amount)) ||
      next.currency !== existing.currency ||
      next.transaction_date !== existing.transaction_date

    // `reconvert` decides whether Postgres recomputes converted_amount or keeps
    // the stored value.
    let reconvert = false
    let conv = {
      exchange_rate: existing.exchange_rate,
      converted_currency: existing.converted_currency,
      rate_date: existing.rate_date,
      rate_source: existing.rate_source,
      rate_is_approximate: existing.rate_is_approximate,
    }

    // Re-convert when money-relevant fields changed, or when the row is still
    // pending a rate (an edit is a good moment to retry).
    if (moneyChanged || existing.converted_amount === null) {
      // Snapshot: re-convert against the row's OWN target currency, never the
      // profile's current one, or history gets re-denominated.
      const home = existing.converted_currency || (await homeCurrencyFor(req.userId))
      if (home) {
        conv = await buildConversion(nextAmountStr, next.currency, next.transaction_date, home)
        reconvert = true
      }
    }

    // Either Postgres recomputes the product in numeric, or the existing value
    // is preserved verbatim. No JS multiplication in either branch.
    const convertedExpr = reconvert
      ? '$2::numeric * $9::numeric'
      : '$15::numeric'

    const { rows } = await asUser(req.userId, () =>
      db.query(
        `update public.transactions set
           transaction_type=$1, amount=$2::numeric, currency=$3, transaction_date=$4,
           category_id=$5, title=$6, description=$7, payment_method_id=$8,
           exchange_rate=$9::numeric, converted_amount=${convertedExpr},
           converted_currency=$10,
           rate_date=$11, rate_source=$12, rate_is_approximate=$13
         where id=$14
         returning *`,
        [
          next.transaction_type, nextAmountStr, next.currency, next.transaction_date,
          next.category_id, next.title, next.description, next.payment_method_id,
          conv.exchange_rate, conv.converted_currency,
          conv.rate_date, conv.rate_source, conv.rate_is_approximate,
          id,
          ...(reconvert ? [] : [existing.converted_amount]),
        ],
        { parsers: DATE_AS_STRING },
      ),
    )
    if (!rows[0]) return res.status(404).json({ error: 'Transaction not found' })
    res.json({ transaction: rows[0] })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/transactions/:id', auth, async (req, res) => {
  try {
    const { rows } = await asUser(req.userId, () =>
      db.query(`delete from public.transactions where id = $1 returning id`, [
        req.params.id,
      ]),
    )
    // RLS means another user's row deletes nothing — report not-found, not success.
    if (!rows[0]) return res.status(404).json({ error: 'Transaction not found' })
    res.json({ ok: true, id: rows[0].id })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Backfill rows saved without a rate.
 *
 * Decision (documented): backfill runs ON READ of the Transactions page, not on
 * a background sweep. Reasons: this is a single-process preview with no job
 * runner, so a sweep would be a fake; the user only cares about a pending value
 * when they are looking at it; and it self-limits — no work happens for idle
 * accounts. Capped per call so one request cannot stall on a long outage.
 */
app.post('/api/transactions/backfill', auth, async (req, res) => {
  const cap = Math.min(Number(req.body?.limit) || 25, 100)
  try {
    const { rows: pending } = await asUser(req.userId, () =>
      db.query(
        `select id, amount, currency, transaction_date, converted_currency
         from public.transactions
         where converted_amount is null
         order by transaction_date desc
         limit ${cap}`,
        [],
        { parsers: DATE_AS_STRING },
      ),
    )

    if (pending.length === 0) return res.json({ attempted: 0, filled: 0 })

    const home = (await homeCurrencyFor(req.userId)) ?? null
    let filled = 0

    for (const row of pending) {
      const target = row.converted_currency || home
      if (!target) continue
      // row.amount is already canonical in storage; pass it through rather than
      // re-validating, so a legacy row can never get stuck un-backfillable.
      const conv = await buildConversion(
        String(row.amount), row.currency, row.transaction_date, target,
      )
      // Still no rate — leave it pending rather than inventing a number.
      if (conv.exchange_rate === null) continue
      await asUser(req.userId, () =>
        db.query(
          `update public.transactions set
             exchange_rate=$1::numeric,
             converted_amount=amount * $1::numeric,
             converted_currency=$2,
             rate_date=$3, rate_source=$4, rate_is_approximate=$5
           where id=$6`,
          [
            conv.exchange_rate, conv.converted_currency,
            conv.rate_date, conv.rate_source, conv.rate_is_approximate, row.id,
          ],
        ),
      )
      filled++
    }
    res.json({ attempted: pending.length, filled })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Overview aggregate. A dedicated endpoint rather than summing the transactions
 * list in the client: that list is capped at 500 rows, so a JS sum would
 * silently under-report for the heaviest users while looking correct in testing.
 * Every total here is computed by Postgres as numeric.
 */
app.get('/api/overview', auth, async (req, res) => {
  const allowed = new Set(['month'])
  const unknown = Object.keys(req.query).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    return res.status(400).json({
      error: `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Supported: month`,
    })
  }

  const month = req.query.month ?? currentMonthString()
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: 'month must be in YYYY-MM format.' })
  }

  try {
    const runAsUser = (sql, params) =>
      asUser(req.userId, () =>
        db.query(sql, params, { parsers: DATE_AS_STRING }),
      ).then((r) => r.rows)

    const { rows: profileRows } = await asUser(req.userId, () =>
      db.query(
        `select home_currency, local_currency, monthly_budget, budget_currency
         from public.profiles where id = $1`,
        [req.userId],
      ),
    )
    const homeCurrency = profileRows[0]?.home_currency ?? null
    const rawBudget =
      profileRows[0]?.monthly_budget === null || profileRows[0]?.monthly_budget === undefined
        ? null
        : String(profileRows[0].monthly_budget)
    // Budgets are set in the local spending currency; totals are in home
    // currency. Convert onto ONE basis before any comparison, or the figures are
    // arithmetically correct nonsense (GBP 1,500 read as KRW 1,500).
    const budgetCurrency =
      profileRows[0]?.budget_currency ?? profileRows[0]?.local_currency ?? null

    let monthlyBudget = null
    let budgetConverted = false
    let budgetBasisUnknown = false

    if (rawBudget !== null) {
      if (!homeCurrency || !budgetCurrency || budgetCurrency === homeCurrency) {
        // Already the same basis, or no currency recorded — use as-is and, when
        // the basis is unknown, say so rather than assuming.
        monthlyBudget = rawBudget
        budgetBasisUnknown = !budgetCurrency && !!rawBudget
      } else {
        const rate = await getRate(budgetCurrency, homeCurrency, currentDateString())
        if (rate && rate.rate !== null) {
          monthlyBudget = multiplyDecimalStrings(rawBudget, rateToNumericString(rate.rate))
          budgetConverted = true
        } else {
          // No rate: suppress budget comparison rather than compare across
          // currencies. A wrong budget figure is worse than an absent one.
          monthlyBudget = null
          budgetBasisUnknown = true
        }
      }
    }

    // Day of month to compare through. For a past month use its full length, so
    // an equal-period comparison of a completed month covers the whole month.
    const today = currentDateString()
    const isCurrentMonth = month === today.slice(0, 7)
    const monthLength = daysInMonth(month)
    const throughDay = isCurrentMonth ? Number(today.slice(8, 10)) : monthLength

    const bounds = equalPeriodBounds(month, throughDay)

    const [current, prior, monthFull] = await Promise.all([
      aggregateWindow(runAsUser, {
        fromDate: dayBound(month, 1),
        toDate: dayBound(month, throughDay),
      }),
      aggregateWindow(runAsUser, {
        fromDate: dayBound(bounds.prior, 1),
        toDate: dayBound(bounds.prior, bounds.priorThroughDay),
      }),
      // Whole-month figures back the four headline numbers, so a past month is
      // reported in full rather than truncated at today's day-of-month.
      aggregateWindow(runAsUser, {
        fromDate: dayBound(month, 1),
        toDate: dayBound(month, monthLength),
      }),
    ])

    // Consecutive days with no expense, ending at the comparison day.
    const streakRows = await runAsUser(
      `select distinct transaction_date::text as d
       from public.transactions
       where transaction_type = 'expense'
         and transaction_date >= $1 and transaction_date <= $2`,
      [dayBound(month, 1), dayBound(month, throughDay)],
    )
    const spendDays = new Set(streakRows.map((r) => r.d))
    let noSpendStreak = 0
    for (let d = throughDay; d >= 1; d--) {
      if (spendDays.has(dayBound(month, d))) break
      noSpendStreak++
    }

    const net = subtractDecimalStrings(monthFull.income, monthFull.expense)
    const budgetRemaining =
      monthlyBudget === null ? null : subtractDecimalStrings(monthlyBudget, monthFull.expense)

    const insights = buildInsights({
      month,
      dayOfMonth: throughDay,
      daysInMonth: monthLength,
      homeCurrency: homeCurrency ?? '',
      current,
      prior,
      priorClamped: bounds.clamped,
      priorThroughDay: bounds.priorThroughDay,
      monthlyBudget,
      noSpendStreak,
    })

    res.json({
      month,
      home_currency: homeCurrency,
      // Four headline numbers, whole month, as exact decimal strings.
      totals: {
        expense: monthFull.expense,
        income: monthFull.income,
        net,
        // null (not 0) when no budget is set, so the UI can offer to set one
        // instead of showing a misleading figure.
        budget_remaining: budgetRemaining,
        // Budget expressed in home currency, comparable with the totals above.
        monthly_budget: monthlyBudget,
        // The figure and currency the user actually entered, so the UI can show
        // "£1,500" rather than only its converted equivalent.
        budget_original: rawBudget,
        budget_currency: budgetCurrency,
        budget_converted: budgetConverted,
        budget_basis_unknown: budgetBasisUnknown,
      },
      // Rows excluded from every total above, surfaced so a total is never
      // quietly wrong.
      pending_count: monthFull.pending_count,
      approximate_count: monthFull.approximate_count,
      transaction_count: monthFull.total_count,
      categories: monthFull.categories,
      comparison: {
        prior_month: bounds.prior,
        through_day: throughDay,
        prior_through_day: bounds.priorThroughDay,
        clamped: bounds.clamped,
        current_expense: current.expense,
        prior_expense: prior.expense,
        // null when there is nothing to compare against, never 0 or Infinity.
        change_absolute:
          prior.total_count === 0
            ? null
            : subtractDecimalStrings(current.expense, prior.expense),
        comparable: prior.total_count > 0 && prior.expense !== '0',
      },
      insights,
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

const PORT = process.env.API_PORT || 8787
app.listen(PORT, '0.0.0.0', () => console.log(`[api] listening on ${PORT}`))
