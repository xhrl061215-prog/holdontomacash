/**
 * Regression guard for the DATE serialisation defect.
 *
 * `transaction_date` is a Postgres DATE — a calendar day, no time, no zone.
 * A driver that parses it into a JS Date serialises to
 * "2026-09-01T00:00:00.000Z"; a client west of UTC then reads the PREVIOUS
 * day, misfiling a 1st-of-month transaction into the previous month.
 *
 * Month bucketing and month-over-month maths in Overview depend on this, so
 * the contract is asserted here: the API returns the bare string.
 *
 * Requires the API running (npm run dev:all).
 */
import { describe, it, expect, beforeAll } from 'vitest'

const API = 'http://localhost:5173/api-proxy'

let token: string
let expenseCategoryId: string

const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token: t, ...rest } = init
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(rest.headers ?? {}),
    },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

beforeAll(async () => {
  const signup = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: `date-regression-${Date.now()}@example.com`,
      password: 'testpass123',
    }),
  })
  token = signup.body.token
  const cats = await call('/api/categories', { token })
  expenseCategoryId = cats.body.categories.find((c: any) => c.type === 'expense').id
}, 30000)

async function saveOn(date: string, title: string) {
  const res = await call('/api/transactions', {
    method: 'POST',
    token,
    body: JSON.stringify({
      transaction_type: 'expense',
      amount: 12,
      currency: 'GBP',
      transaction_date: date,
      category_id: expenseCategoryId,
      title,
    }),
  })
  expect(res.status).toBe(200)
  return res.body.transaction
}

describe('transaction_date is a plain calendar date', () => {
  it('returns bare YYYY-MM-DD from POST, not a timestamp', async () => {
    const tx = await saveOn('2026-08-15', 'Tesco groceries')
    expect(tx.transaction_date).toBe('2026-08-15')
    expect(tx.transaction_date).not.toMatch(/T|Z/)
  })

  it('returns bare YYYY-MM-DD from GET', async () => {
    await saveOn('2026-07-20', 'Bus pass')
    const { body } = await call('/api/transactions', { token })
    for (const t of body.transactions) {
      expect(t.transaction_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('keeps the stored day exactly on a month boundary', async () => {
    // The case that silently misfiles: midnight on the 1st.
    const tx = await saveOn('2026-09-01', 'Rent')
    expect(tx.transaction_date).toBe('2026-09-01')
    // Month bucketing by string slice is timezone-independent.
    expect(tx.transaction_date.slice(0, 7)).toBe('2026-09')
  })

  it('keeps the stored day on a year boundary', async () => {
    const tx = await saveOn('2027-01-01', 'New year meal')
    expect(tx.transaction_date).toBe('2027-01-01')
    expect(tx.transaction_date.slice(0, 4)).toBe('2027')
  })

  it('does not shift the date when read as a Date in a non-UTC zone', async () => {
    // Reproduces the original defect end to end: had the API returned a
    // timestamp, this assertion would fail for any zone west of UTC.
    const tx = await saveOn('2026-09-01', 'Boundary check')
    for (const timeZone of ['America/Los_Angeles', 'Asia/Seoul', 'UTC']) {
      const asLocalDay = new Date(`${tx.transaction_date}T12:00:00`)
        .toLocaleDateString('en-CA', { timeZone })
      expect(asLocalDay).toBe('2026-09-01')
    }
  })

  it('still returns created_at as a real timestamp', async () => {
    // The fix must be scoped to DATE columns only.
    const { body } = await call('/api/transactions', { token })
    expect(body.transactions[0].created_at).toMatch(/T.*Z$/)
  })
})
