// The exact journey demanded: create an account, add a transaction, log out,
// log back in, and still see it. Plus cross-user isolation over real HTTP.
const BASE = 'http://localhost:5173/api-proxy'

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const email = `lily-test-${Date.now()}@example.com`
const pw = 'testpass123'
let fail = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) fail++
}

console.log('--- 1. sign up ---')
const su = await call('/auth/signup', { method: 'POST', body: { email, password: pw } })
check('account created', su.status === 200 && !!su.body.token, su.body.error || '')
let token = su.body.token

console.log('\n--- 2. signup seeded defaults (DB trigger) ---')
const cats = await call('/api/categories', { token })
const pms = await call('/api/payment-methods', { token })
// Assert the brief's lists by NAME, not by count. A count passes while the
// content has been silently substituted — which is exactly how the wrong
// categories survived four rounds of review.
const BRIEF_EXPENSE = ['Groceries', 'Eating Out', 'Academic', 'Entertainment / Nightlife',
  'Transport', 'Phone / Internet', 'Housing / Living', 'Shopping', 'Health', 'Travel',
  'Subscription', 'Other']
const BRIEF_INCOME = ['Allowance', 'Salary', 'Scholarship', 'Refund', 'Other']
const BRIEF_PM = ['Debit Card', 'Credit Card', 'Global / Travel Card', 'Cash',
  'Bank Transfer', 'Other']

const seededExpense = (cats.body.categories ?? [])
  .filter((c) => c.type === 'expense').sort((a, b) => a.sort_order - b.sort_order)
  .map((c) => c.name)
const seededIncome = (cats.body.categories ?? [])
  .filter((c) => c.type === 'income').sort((a, b) => a.sort_order - b.sort_order)
  .map((c) => c.name)
const seededPm = (pms.body.payment_methods ?? [])
  .sort((a, b) => a.sort_order - b.sort_order).map((p) => p.name)

check('expense categories match the brief exactly',
  JSON.stringify(seededExpense) === JSON.stringify(BRIEF_EXPENSE), seededExpense.join(', '))
check('income categories match the brief exactly',
  JSON.stringify(seededIncome) === JSON.stringify(BRIEF_INCOME), seededIncome.join(', '))
check('payment methods match the brief exactly',
  JSON.stringify(seededPm) === JSON.stringify(BRIEF_PM), seededPm.join(', '))
check('exactly one default payment method',
  (pms.body.payment_methods ?? []).filter((p) => p.is_default).length === 1)

console.log('\n--- 3. profile starts un-onboarded ---')
const p0 = await call('/api/profile', { token })
check('profile exists', !!p0.body.profile)
check('onboarded is false', p0.body.profile?.onboarded === false)
check('monthly_budget is null', p0.body.profile?.monthly_budget === null)

console.log('\n--- 4. onboarding, budget left blank ---')
const ob = await call('/api/profile', {
  method: 'PATCH', token,
  body: { study_country: 'KR', local_currency: 'KRW', home_currency: 'USD', display_currency: 'USD', monthly_budget: null, onboarded: true },
})
check('onboarding saved', ob.body.profile?.onboarded === true, ob.body.error || '')
check('blank budget stayed null, not 0', ob.body.profile?.monthly_budget === null, `got ${ob.body.profile?.monthly_budget}`)
check('local currency stored', ob.body.profile?.local_currency === 'KRW')

console.log('\n--- 5. add a transaction ---')
const foodCat = cats.body.categories.find((c) => c.name === 'Groceries' && c.type === 'expense')
const cash = pms.body.payment_methods.find((p) => p.name === 'Cash')
const tx = await call('/api/transactions', {
  method: 'POST', token,
  body: {
    transaction_type: 'expense', amount: 12000, currency: 'KRW',
    transaction_date: '2026-08-15', category_id: foodCat.id,
    title: 'Lunch at campus cafe', description: 'with classmates',
    payment_method_id: cash.id,
  },
})
check('transaction saved', tx.status === 200 && !!tx.body.transaction?.id, tx.body.error || '')
check('amount correct', Number(tx.body.transaction?.amount) === 12000)
check('bound to this user', tx.body.transaction?.user_id === su.body.user.id)

console.log('\n--- 6. rejects bad data (DB constraints) ---')
const neg = await call('/api/transactions', {
  method: 'POST', token,
  body: { transaction_type: 'expense', amount: -5, currency: 'KRW', transaction_date: '2026-08-15', title: 'bad' },
})
check('negative amount rejected', neg.status === 400, `status ${neg.status}`)
const badType = await call('/api/transactions', {
  method: 'POST', token,
  body: { transaction_type: 'transfer', amount: 5, currency: 'KRW', transaction_date: '2026-08-15', title: 'bad' },
})
check('invalid type rejected', badType.status === 400, `status ${badType.status}`)

console.log('\n--- 7. log out ---')
const so = await call('/auth/signout', { method: 'POST', token })
check('signed out', so.status === 200)
const afterOut = await call('/api/transactions', { token })
check('old token no longer works', afterOut.status === 401, `status ${afterOut.status}`)

console.log('\n--- 8. log back in, data still there ---')
const si = await call('/auth/signin', { method: 'POST', body: { email, password: pw } })
check('signed back in', si.status === 200 && !!si.body.token, si.body.error || '')
token = si.body.token
const back = await call('/api/transactions', { token })
check('transaction persisted', back.body.transactions?.length === 1, `got ${back.body.transactions?.length}`)
check('title intact', back.body.transactions?.[0]?.title === 'Lunch at campus cafe')
check('category joined', back.body.transactions?.[0]?.category_name === 'Groceries')
check('payment method joined', back.body.transactions?.[0]?.payment_method_name === 'Cash')
const pBack = await call('/api/profile', { token })
check('still onboarded (no repeat onboarding)', pBack.body.profile?.onboarded === true)

console.log('\n--- 9. wrong password rejected ---')
const bad = await call('/auth/signin', { method: 'POST', body: { email, password: 'wrongpass' } })
check('wrong password rejected', bad.status === 400, `status ${bad.status}`)

console.log('\n--- 10. cross-user isolation (RLS) ---')
const u2 = await call('/auth/signup', { method: 'POST', body: { email: `other-${Date.now()}@example.com`, password: pw } })
const t2 = u2.body.token
const u2tx = await call('/api/transactions', { token: t2 })
check('second user sees 0 transactions', u2tx.body.transactions?.length === 0, `got ${u2tx.body.transactions?.length}`)
const u2cats = await call('/api/categories', { token: t2 })
check('second user sees own categories only, not both users\' combined',
  u2cats.body.categories?.length === BRIEF_EXPENSE.length + BRIEF_INCOME.length,
  `got ${u2cats.body.categories?.length}`)
const u1again = await call('/api/transactions', { token })
check('first user still sees only their own 1', u1again.body.transactions?.length === 1, `got ${u1again.body.transactions?.length}`)
const dupe = await call('/auth/signup', { method: 'POST', body: { email, password: pw } })
check('duplicate email rejected', dupe.status === 400, `status ${dupe.status}`)

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
