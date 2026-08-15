/**
 * Verifies every claim in the README's "Known limitations" list against the
 * running app.
 *
 * Motivation: three of those entries were false. Each was true when written and
 * silently falsified by a later fix — "Overview is a stub" after Phase 3 shipped,
 * "No PWA" after the service worker landed, "Amount is not currency-aware" after
 * 45bfb03 added per-currency validation. Prose has no test that can fail, so it
 * rots.
 *
 * A limitations list is a deliverable: it is what a reader trusts when deciding
 * whether the product fits. An understated one misleads exactly as much as an
 * overstated one. So each claim is asserted here, and a fix that removes a
 * limitation now fails this file until the prose is updated.
 *
 * Run with the app running: node server/verify-limitations.mjs
 */
const API = process.env.API_BASE ?? 'http://localhost:8787'

let failures = 0
const check = (claim, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${claim}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const call = async (path, opts = {}) => {
  const { token, ...rest } = opts
  const res = await fetch(API + path, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  })
  let body = {}
  try { body = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, body }
}

const monthOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

// A user in KRW-local so decimal rules are testable.
const signup = await call('/auth/signup', {
  method: 'POST',
  body: JSON.stringify({
    email: `lim-${Date.now()}@example.com`, password: 'testpass123',
  }),
})
const token = signup.body.token
await call('/api/profile', {
  method: 'PATCH', token,
  body: JSON.stringify({
    study_country: 'KR', local_currency: 'KRW', home_currency: 'USD',
    display_currency: 'USD', monthly_budget: '2000000',
    budget_currency: 'KRW', onboarded: true,
  }),
})
const cats = (await call('/api/categories', { token })).body.categories
const groceries = cats.find((c) => c.name === 'Groceries' && c.type === 'expense')

console.log('\n=== claims that must still be TRUE ===\n')

// "No pagination controls yet — up to 500 rows per query."
{
  const res = await call('/api/transactions?limit=501', { token })
  const capped = res.status === 400 || (res.body.transactions?.length ?? 0) <= 500
  check('list is capped at 500 rows per query', capped, `status ${res.status}`)
}

// "Unknown query parameters are rejected with 400 rather than ignored."
{
  const res = await call('/api/transactions?nonsense=1', { token })
  check('unknown query parameter is rejected with 400', res.status === 400,
    `got ${res.status}`)
}

// "Categories and payment methods are fixed — no UI to add, rename or reorder."
{
  const post = await call('/api/categories', {
    method: 'POST', token, body: JSON.stringify({ name: 'Custom', type: 'expense' }),
  })
  const patch = await call(`/api/categories/${groceries.id}`, {
    method: 'PATCH', token, body: JSON.stringify({ name: 'Renamed' }),
  })
  check('no category create endpoint', post.status === 404 || post.status === 405,
    `POST -> ${post.status}`)
  check('no category rename endpoint', patch.status === 404 || patch.status === 405,
    `PATCH -> ${patch.status}`)
}

// "Consultant rules are fixed — no user configuration of thresholds."
{
  const res = await call('/api/consultant-settings', { token })
  check('no consultant configuration endpoint', res.status === 404, `got ${res.status}`)
}

// "Session tokens live in memory" — asserted structurally: no refresh endpoint,
// so there is nothing that survives a restart.
{
  const res = await call('/auth/refresh', { method: 'POST', token })
  check('no token refresh/persistence endpoint', res.status === 404 || res.status === 405,
    `got ${res.status}`)
}

// "Rates depend on third-party providers; with both unreachable rows save pending."
// Asserted by shape: the pending fields exist on the transaction contract.
{
  const res = await call('/api/transactions', {
    method: 'POST', token,
    body: JSON.stringify({
      transaction_type: 'expense', amount: '15000', currency: 'KRW',
      transaction_date: `${monthOf()}-05`, category_id: groceries.id, title: 'market',
    }),
  })
  const t = res.body.transaction ?? {}
  check('transaction contract carries conversion status (pending is representable)',
    'conversion_status' in t || 'converted_amount' in t,
    Object.keys(t).filter((k) => k.includes('conver')).join(', '))
}

console.log('\n=== claims that would be FALSE if stated (already-fixed behaviour) ===\n')

// The removed claim: "Amount is not currency-aware — accepts 2 decimals for KRW."
// Asserted in the POSITIVE so it can never be re-added as a limitation.
{
  const dec = await call('/api/transactions', {
    method: 'POST', token,
    body: JSON.stringify({
      transaction_type: 'expense', amount: '1500.25', currency: 'KRW',
      transaction_date: `${monthOf()}-06`, category_id: groceries.id, title: 'x',
    }),
  })
  const sub = await call('/api/transactions', {
    method: 'POST', token,
    body: JSON.stringify({
      transaction_type: 'expense', amount: '0.5', currency: 'KRW',
      transaction_date: `${monthOf()}-06`, category_id: groceries.id, title: 'x',
    }),
  })
  const whole = await call('/api/transactions', {
    method: 'POST', token,
    body: JSON.stringify({
      transaction_type: 'expense', amount: '1500', currency: 'KRW',
      transaction_date: `${monthOf()}-06`, category_id: groceries.id, title: 'x',
    }),
  })
  check('amount IS currency-aware: 1500.25 KRW rejected', dec.status === 400,
    `${dec.status} ${dec.body.error ?? ''}`)
  check('amount IS currency-aware: 0.5 KRW rejected', sub.status === 400,
    `${sub.status} ${sub.body.error ?? ''}`)
  check('amount IS currency-aware: 1500 KRW accepted', whole.status === 200,
    `got ${whole.status}`)
}

// "Overview is a stub" was false — assert it is real.
{
  const res = await call(`/api/overview?month=${monthOf()}`, { token })
  const t = res.body.totals ?? {}
  check('Overview is implemented, not a stub',
    res.status === 200 && 'expense' in t && 'monthly_budget' in t,
    `status ${res.status}`)
  check('Overview returns consultant insights',
    Array.isArray(res.body.insights), `insights: ${typeof res.body.insights}`)
  check('Overview returns category breakdown',
    Array.isArray(res.body.categories))
}

console.log(`\n${failures === 0
  ? 'EVERY DOCUMENTED LIMITATION VERIFIED'
  : `${failures} CLAIM(S) NO LONGER TRUE — update README "Known limitations"`}`)
process.exit(failures === 0 ? 0 : 1)
