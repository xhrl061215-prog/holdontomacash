/**
 * Independent reconciliation check.
 *
 * The acceptance requirement is that Overview totals reconcile EXACTLY against
 * the Transactions table. This script verifies it in the direction the test
 * suite does not: it builds a randomised ledger, sums the raw rows with exact
 * decimal arithmetic here, and compares against what /api/overview reports.
 *
 * Deliberately independent of the app's own aggregation, so a shared bug cannot
 * make both sides agree.
 *
 * Usage: node server/reconcile.mjs   (needs the API running)
 */

const API = process.env.API_BASE || 'http://localhost:5173/api-proxy'

// ---- exact decimal arithmetic, independent of src/lib/decimal.ts ----
function toParts(v) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v ?? '0').trim())
  if (!m) throw new Error(`not a decimal: ${v}`)
  const [, sign, int, frac = ''] = m
  return [BigInt((sign === '-' ? '-' : '') + int + frac), frac.length]
}
function sum(values) {
  let scale = 0
  const parsed = values.map((v) => {
    const [n, s] = toParts(v)
    scale = Math.max(scale, s)
    return [n, s]
  })
  let total = 0n
  for (const [n, s] of parsed) total += n * 10n ** BigInt(scale - s)
  return [total, scale]
}
function eq(a, b) {
  const [an, as] = toParts(a)
  const [bn, bs] = toParts(b)
  const s = Math.max(as, bs)
  return an * 10n ** BigInt(s - as) === bn * 10n ** BigInt(s - bs)
}
function render([n, scale]) {
  const neg = n < 0n
  const d = (neg ? -n : n).toString().padStart(scale + 1, '0')
  let out = scale === 0 ? d : `${d.slice(0, d.length - scale)}.${d.slice(d.length - scale)}`
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return (neg ? '-' : '') + (out || '0')
}

const call = async (path, init = {}) => {
  const { token, ...rest } = init
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ---- build a randomised ledger ----
const CURRENCIES = ['GBP', 'USD', 'EUR', 'JPY', 'KRW']
const ZERO_DEC = new Set(['JPY', 'KRW'])

function randomAmount(currency) {
  // Respect each currency's decimal rules, as the API enforces them.
  if (ZERO_DEC.has(currency)) return String(1 + Math.floor(Math.random() * 50000))
  const units = 1 + Math.floor(Math.random() * 500)
  const cents = Math.floor(Math.random() * 100)
  return `${units}.${String(cents).padStart(2, '0')}`
}

const month = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
})()
const dayOf = (d) => `${month}-${String(d).padStart(2, '0')}`

console.log(`Reconciling ${month} against an independently summed ledger\n`)

const signup = await call('/auth/signup', {
  method: 'POST',
  body: JSON.stringify({
    email: `reconcile-${Date.now()}@example.com`,
    password: 'testpass123',
  }),
})
const token = signup.body.token

await call('/api/profile', {
  method: 'PATCH', token,
  body: JSON.stringify({
    study_country: 'GB', local_currency: 'GBP', home_currency: 'KRW',
    display_currency: 'KRW', monthly_budget: '3000000', onboarded: true,
  }),
})

const cats = (await call('/api/categories', { token })).body.categories
const expenseCats = cats.filter((c) => c.type === 'expense')
const incomeCats = cats.filter((c) => c.type === 'income')

const ROWS = 60
let created = 0
for (let i = 0; i < ROWS; i++) {
  const isIncome = Math.random() < 0.2
  const currency = CURRENCIES[Math.floor(Math.random() * CURRENCIES.length)]
  const pool = isIncome ? incomeCats : expenseCats
  const category = pool[Math.floor(Math.random() * pool.length)]
  const res = await call('/api/transactions', {
    method: 'POST', token,
    body: JSON.stringify({
      transaction_type: isIncome ? 'income' : 'expense',
      amount: randomAmount(currency),
      currency,
      transaction_date: dayOf(1 + Math.floor(Math.random() * 28)),
      category_id: category.id,
      title: `row ${i}`,
    }),
  })
  if (res.status === 200) created++
}
console.log(`Created ${created}/${ROWS} transactions\n`)

// ---- independently sum the raw rows ----
const list = await call(`/api/transactions?month=${month}&limit=1000`, { token })
const rows = list.body.transactions
const settled = rows.filter((r) => r.converted_amount !== null)
const pending = rows.filter((r) => r.converted_amount === null)

const myExpense = render(
  sum(settled.filter((r) => r.transaction_type === 'expense').map((r) => r.converted_amount)),
)
const myIncome = render(
  sum(settled.filter((r) => r.transaction_type === 'income').map((r) => r.converted_amount)),
)

const ov = (await call(`/api/overview?month=${month}`, { token })).body

console.log(`rows: ${rows.length} total, ${settled.length} settled, ${pending.length} pending\n`)

check('expense total matches independent sum', eq(ov.totals.expense, myExpense),
  `overview ${ov.totals.expense} vs ${myExpense}`)
check('income total matches independent sum', eq(ov.totals.income, myIncome),
  `overview ${ov.totals.income} vs ${myIncome}`)
check('pending count matches', ov.pending_count === pending.length,
  `overview ${ov.pending_count} vs ${pending.length}`)
check('transaction count matches', ov.transaction_count === rows.length,
  `overview ${ov.transaction_count} vs ${rows.length}`)

// net and budget must be exactly derivable
check('net equals income minus expense',
  eq(render(sum([ov.totals.net, ov.totals.expense])), ov.totals.income))
check('budget remaining equals budget minus expense',
  eq(render(sum([ov.totals.budget_remaining, ov.totals.expense])), ov.totals.monthly_budget))

// per-category reconciliation
let catMismatch = 0
for (const cat of ov.categories) {
  const mine = render(
    sum(
      settled
        .filter((r) => r.transaction_type === 'expense' && r.category_id === cat.category_id)
        .map((r) => r.converted_amount),
    ),
  )
  if (!eq(cat.total, mine)) {
    catMismatch++
    console.log(`   ✗ ${cat.category_name}: overview ${cat.total} vs ${mine}`)
  }
}
check(`all ${ov.categories.length} category totals reconcile`, catMismatch === 0)

check('category totals sum to the expense total',
  eq(render(sum(ov.categories.map((c) => c.total))), ov.totals.expense))

// no float dust anywhere
const dusty = [ov.totals.expense, ov.totals.income, ov.totals.net, ov.totals.budget_remaining]
  .filter((v) => /\.\d*(0{8,}\d|9{8,}\d)/.test(String(v)))
check('no binary-float dust in any total', dusty.length === 0, dusty.join(', '))

// filtered reconciliation: each currency subset
let currencyMismatch = 0
for (const currency of CURRENCIES) {
  const filtered = await call(
    `/api/transactions?month=${month}&type=expense&currency=${currency}&limit=1000`,
    { token },
  )
  const mine = render(
    sum(
      filtered.body.transactions
        .filter((r) => r.converted_amount !== null)
        .map((r) => r.converted_amount),
    ),
  )
  const direct = render(
    sum(
      settled
        .filter((r) => r.transaction_type === 'expense' && r.currency === currency)
        .map((r) => r.converted_amount),
    ),
  )
  if (!eq(mine, direct)) {
    currencyMismatch++
    console.log(`   ✗ ${currency}: filtered ${mine} vs direct ${direct}`)
  }
}
check('filtered queries reconcile per currency', currencyMismatch === 0)

console.log(`\n${failures === 0 ? 'RECONCILED EXACTLY' : `${failures} MISMATCH(ES)`}`)
process.exit(failures === 0 ? 0 : 1)
