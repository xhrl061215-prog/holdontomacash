/**
 * Adversarial input tests.
 *
 * The gap these close: the earlier suites asserted correct arithmetic on
 * well-formed inputs (all <=2dp), where the stored form equals the submitted
 * form. The basis-mismatch defect lived precisely where those differ — 2.675
 * stored as 2.68 while conversion used 2.675 — so no test could reach it.
 *
 * The method here is to ask what input would have to ARRIVE for a calculation
 * to break, then send it. Adversarial inputs, not just adversarial code.
 *
 * The central invariant: a stored row must be internally consistent —
 * converted_amount == amount * exchange_rate using the row's OWN stored values.
 * Requires the API running (npm run dev:all).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { decimalMultiply, decimalEquals } from '../lib/decimal'

const API = 'http://localhost:5173/api-proxy'

const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
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

async function makeUser(local: string, home: string) {
  const { body } = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: `adv-${Math.random().toString(36).slice(2)}-${Date.now()}@example.com`,
      password: 'testpass123',
    }),
  })
  await call('/api/profile', {
    method: 'PATCH', token: body.token,
    body: JSON.stringify({
      study_country: 'XX', local_currency: local, home_currency: home,
      display_currency: home, monthly_budget: null, onboarded: true,
    }),
  })
  const cats = await call('/api/categories', { token: body.token })
  return {
    token: body.token,
    expenseCategory: cats.body.categories.find((c: any) => c.type === 'expense').id,
  }
}

const post = (token: string, amount: unknown, currency: string, extra = {}) =>
  call('/api/transactions', {
    method: 'POST', token,
    body: JSON.stringify({
      transaction_type: 'expense', amount, currency,
      transaction_date: '2026-08-14', title: 'adversarial', ...extra,
    }),
  })

/** The invariant that the basis mismatch violated. */
function assertInternallyConsistent(tx: any) {
  if (tx.converted_amount === null) return // pending is legitimately null
  const expected = decimalMultiply(String(tx.amount), String(tx.exchange_rate))
  expect(
    decimalEquals(tx.converted_amount, expected),
    `row is internally inconsistent: stored amount ${tx.amount} x rate ` +
      `${tx.exchange_rate} = ${expected}, but converted_amount is ` +
      `${tx.converted_amount}`,
  ).toBe(true)
}

// ---------------------------------------------------------------------------

describe('amounts with more decimals than the currency supports', () => {
  let u: Awaited<ReturnType<typeof makeUser>>
  beforeAll(async () => { u = await makeUser('GBP', 'KRW') }, 30000)

  // The reported case and neighbours. Each rounds UP at 2dp, so a stored-vs-
  // submitted mismatch would be silent and material.
  it.each(['2.675', '1.005', '12.999', '0.001', '99.9999', '3.14159'])(
    'rejects %s for a 2-decimal currency rather than silently rounding',
    async (amount) => {
      const res = await post(u.token, amount, 'GBP', { category_id: u.expenseCategory })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/decimal places/i)
    },
  )

  it('accepts the 2dp equivalent and stores an internally consistent row', async () => {
    const res = await post(u.token, '2.68', 'GBP', { category_id: u.expenseCategory })
    expect(res.status).toBe(200)
    expect(decimalEquals(res.body.transaction.amount, '2.68')).toBe(true)
    assertInternallyConsistent(res.body.transaction)
  }, 30000)
})

describe('zero-decimal currencies', () => {
  let u: Awaited<ReturnType<typeof makeUser>>
  beforeAll(async () => { u = await makeUser('KRW', 'GBP') }, 30000)

  it.each(['0.5', '27431.50', '5000.01', '1.5'])(
    'rejects %s KRW, which has no minor unit',
    async (amount) => {
      const res = await post(u.token, amount, 'KRW', { category_id: u.expenseCategory })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/no decimal unit/i)
    },
  )

  it.each(['5000', '1', '27431'])('accepts whole KRW amount %s', async (amount) => {
    const res = await post(u.token, amount, 'KRW', { category_id: u.expenseCategory })
    expect(res.status).toBe(200)
    assertInternallyConsistent(res.body.transaction)
  }, 30000)

  it('applies the rule per currency, not globally', async () => {
    // Same user, same request shape — only the currency differs.
    const krw = await post(u.token, '10.50', 'KRW', { category_id: u.expenseCategory })
    expect(krw.status).toBe(400)
    const gbp = await post(u.token, '10.50', 'GBP', { category_id: u.expenseCategory })
    expect(gbp.status).toBe(200)
  }, 30000)
})

describe('zero and malformed amounts', () => {
  let u: Awaited<ReturnType<typeof makeUser>>
  beforeAll(async () => { u = await makeUser('GBP', 'KRW') }, 30000)

  // "00" slipped through an earlier version of the check and stored 0.00.
  it.each(['0', '0.0', '0.00', '00', '000', '0.000000'])(
    'rejects zero amount %s',
    async (amount) => {
      const res = await post(u.token, amount, 'GBP', { category_id: u.expenseCategory })
      expect(res.status).toBe(400)
      // Must report the real reason, not a misleading decimals complaint.
      expect(res.body.error).toMatch(/greater than 0/i)
    },
  )

  it.each([
    '-5', 'abc', '', '   ', '1e3', 'Infinity', 'NaN', '12.5.6', '+7',
    '1,000', '£12', '0x10', '--1', '.', '.5',
  ])('rejects malformed amount %j', async (amount) => {
    const res = await post(u.token, amount, 'GBP', { category_id: u.expenseCategory })
    expect(res.status).toBe(400)
  })

  it.each([null, undefined, {}, [], true])(
    'rejects non-string amount %j',
    async (amount) => {
      const res = await post(u.token, amount, 'GBP', { category_id: u.expenseCategory })
      expect(res.status).toBe(400)
    },
  )

  it('normalises redundant leading zeros without changing the value', async () => {
    const res = await post(u.token, '007.50', 'GBP', { category_id: u.expenseCategory })
    expect(res.status).toBe(200)
    expect(decimalEquals(res.body.transaction.amount, '7.5')).toBe(true)
    assertInternallyConsistent(res.body.transaction)
  }, 30000)
})

describe('very large and very small amounts', () => {
  let u: Awaited<ReturnType<typeof makeUser>>
  beforeAll(async () => { u = await makeUser('GBP', 'KRW') }, 30000)

  it('rejects an over-long amount with a clear limit, not a database error', async () => {
    const res = await post(u.token, '99999999999999999999', 'GBP', {
      category_id: u.expenseCategory,
    })
    expect(res.status).toBe(400)
    // Must be a sentence naming the limit, not a leaked "numeric field overflow".
    expect(res.body.error).toMatch(/too large/i)
    expect(res.body.error).toMatch(/16 digits/)
    expect(res.body.error).not.toMatch(/numeric field overflow/i)
  }, 30000)

  it('accepts the largest amount that fits and rejects one digit more', async () => {
    const ok = await post(u.token, '9999999999999999', 'GBP', {
      category_id: u.expenseCategory,
    })
    expect(ok.status).toBe(200)
    assertInternallyConsistent(ok.body.transaction)

    const tooBig = await post(u.token, '99999999999999999', 'GBP', {
      category_id: u.expenseCategory,
    })
    expect(tooBig.status).toBe(400)
  }, 30000)

  it('stores a large valid amount with an exact conversion', async () => {
    // Large enough that a float product would lose integer precision.
    const res = await post(u.token, '9999999.99', 'GBP', { category_id: u.expenseCategory })
    expect(res.status).toBe(200)
    assertInternallyConsistent(res.body.transaction)
  }, 30000)

  it('stores the smallest valid amount exactly', async () => {
    const res = await post(u.token, '0.01', 'GBP', { category_id: u.expenseCategory })
    expect(res.status).toBe(200)
    expect(decimalEquals(res.body.transaction.amount, '0.01')).toBe(true)
    assertInternallyConsistent(res.body.transaction)
  }, 30000)
})

describe('edits are validated on the same rules as inserts', () => {
  it('rejects an edit that would introduce excess decimals', async () => {
    const u = await makeUser('GBP', 'KRW')
    const created = await post(u.token, '10.00', 'GBP', { category_id: u.expenseCategory })
    const id = created.body.transaction.id

    const bad = await call(`/api/transactions/${id}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ amount: '2.675' }),
    })
    expect(bad.status).toBe(400)

    // The row is untouched and still consistent.
    const after = await call('/api/transactions', { token: u.token })
    expect(decimalEquals(after.body.transactions[0].amount, '10.00')).toBe(true)
    assertInternallyConsistent(after.body.transactions[0])
  }, 40000)

  it('rejects an edit to zero', async () => {
    const u = await makeUser('GBP', 'KRW')
    const created = await post(u.token, '10.00', 'GBP', { category_id: u.expenseCategory })
    const bad = await call(`/api/transactions/${created.body.transaction.id}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ amount: '0' }),
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/greater than 0/i)
  }, 40000)

  it('re-validates against the NEW currency when the currency changes', async () => {
    // 10.50 is valid GBP but invalid KRW — switching currency must re-check.
    const u = await makeUser('GBP', 'USD')
    const created = await post(u.token, '10.50', 'GBP', { category_id: u.expenseCategory })
    expect(created.status).toBe(200)

    const bad = await call(`/api/transactions/${created.body.transaction.id}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ currency: 'KRW' }),
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/no decimal unit/i)
  }, 40000)

  it('keeps a row consistent after a valid amount edit', async () => {
    const u = await makeUser('GBP', 'KRW')
    const created = await post(u.token, '10.00', 'GBP', { category_id: u.expenseCategory })
    const edited = await call(`/api/transactions/${created.body.transaction.id}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ amount: '33.33' }),
    })
    expect(edited.status).toBe(200)
    expect(decimalEquals(edited.body.transaction.amount, '33.33')).toBe(true)
    assertInternallyConsistent(edited.body.transaction)
  }, 40000)
})

describe('every stored row is internally consistent, whatever arrived', () => {
  it('holds across a mixed barrage of valid and invalid inputs', async () => {
    const u = await makeUser('GBP', 'KRW')
    const attempts = [
      '2.675', '2.68', '0', '00', '10', '0.01', '-1', 'abc', '007.50',
      '9999999.99', '1.005', '33.33', '', '1e3', '12.50',
    ]
    for (const amount of attempts) {
      await post(u.token, amount, 'GBP', { category_id: u.expenseCategory })
    }

    // Whatever was accepted, no stored row may be self-inconsistent.
    const { body } = await call('/api/transactions', { token: u.token })
    expect(body.transactions.length).toBeGreaterThan(0)
    for (const tx of body.transactions) assertInternallyConsistent(tx)

    // And nothing invalid got through.
    for (const tx of body.transactions) {
      expect(Number(tx.amount)).toBeGreaterThan(0)
      const [, frac = ''] = String(tx.amount).split('.')
      // Stored at the column's 2dp scale; never more precise than submitted.
      expect(frac.length).toBeLessThanOrEqual(2)
    }
  }, 90000)
})
