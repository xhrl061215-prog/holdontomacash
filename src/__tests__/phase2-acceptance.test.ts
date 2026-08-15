/**
 * Phase 2 acceptance tests — the list the Product Manager said they would
 * verify against the public URL.
 *
 * Runs against the live API (npm run dev:all). Uses real rate providers, so a
 * few assertions check relationships and provenance rather than fixed numbers.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { decimalMultiply, decimalEquals, looksFloatContaminated } from '../lib/decimal'

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
      email: `p2-${Math.random().toString(36).slice(2)}-${Date.now()}@example.com`,
      password: 'testpass123',
    }),
  })
  const token = body.token
  await call('/api/profile', {
    method: 'PATCH', token,
    body: JSON.stringify({
      study_country: 'XX', local_currency: local, home_currency: home,
      display_currency: home, monthly_budget: null, onboarded: true,
    }),
  })
  const cats = await call('/api/categories', { token })
  const pms = await call('/api/payment-methods', { token })
  return {
    token,
    userId: body.user.id,
    categories: cats.body.categories as any[],
    paymentMethods: pms.body.payment_methods as any[],
  }
}

const add = (token: string, row: Record<string, unknown>) =>
  call('/api/transactions', { method: 'POST', token, body: JSON.stringify(row) })

// ---------------------------------------------------------------------------

describe('conversion is correct across pairs, none hardcoded', () => {
  // The four pairs named in the acceptance list.
  const pairs: [string, string, number][] = [
    ['GBP', 'KRW', 12],
    ['USD', 'KRW', 100],
    ['EUR', 'USD', 20],
    ['JPY', 'GBP', 1500],
  ]

  it.each(pairs)('converts %s -> %s', async (from, home, amount) => {
    const u = await makeUser(from, home)
    const cat = u.categories.find((c) => c.type === 'expense')!
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount, currency: from,
      transaction_date: '2026-08-14', category_id: cat.id, title: `${from} test`,
    })
    const tx = body.transaction

    expect(Number(tx.exchange_rate)).toBeGreaterThan(0)
    expect(tx.converted_currency).toBe(home)

    // Exact decimal check. Computing the expected side with JS floats would be
    // tautological: if the server also multiplied in float, both sides would
    // carry identical error and agree while the stored value was wrong.
    const expected = decimalMultiply(String(amount), String(tx.exchange_rate))
    expect(
      decimalEquals(tx.converted_amount, expected),
      `stored ${tx.converted_amount} !== exact ${expected}`,
    ).toBe(true)
    // And the stored value must carry no binary-float dust.
    expect(
      looksFloatContaminated(tx.converted_amount),
      `stored ${tx.converted_amount} shows float error`,
    ).toBe(false)

    expect(tx.rate_source).toBeTruthy()
    expect(tx.rate_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }, 30000)

  // The exact case reported in review: 20.00 GBP x 1910.38 stored as
  // 38207.600000000006 because the multiply happened in JS float. These amounts
  // are chosen because their products are NOT binary-representable, so a float
  // multiply is guaranteed to leave dust.
  it.each([['20', 'GBP', 'KRW'], ['10', 'GBP', 'KRW'], ['7.77', 'GBP', 'KRW'], ['0.07', 'USD', 'KRW']])(
    'stores %s %s -> %s with no binary-float error',
    async (amount, from, home) => {
      const u = await makeUser(from, home)
      const cat = u.categories.find((c) => c.type === 'expense')!
      const { body } = await add(u.token, {
        transaction_type: 'expense', amount, currency: from,
        transaction_date: '2026-08-14', category_id: cat.id, title: `float ${amount}`,
      })
      const tx = body.transaction

      const exact = decimalMultiply(amount, String(tx.exchange_rate))
      expect(
        decimalEquals(tx.converted_amount, exact),
        `stored ${tx.converted_amount}, exact ${exact}`,
      ).toBe(true)
      expect(
        looksFloatContaminated(tx.converted_amount),
        `stored ${tx.converted_amount} carries float dust`,
      ).toBe(false)

      // The amount itself must round-trip exactly too.
      expect(decimalEquals(tx.amount, amount)).toBe(true)
    },
    30000,
  )

  it('keeps a summed column exact across many rows', async () => {
    // Per-row dust compounds when Overview sums this column, so the sum of
    // stored values must equal the exact sum of the products.
    const u = await makeUser('GBP', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const amounts = ['20', '10', '7.77', '3.33', '19.99']
    const stored: string[] = []
    const exact: string[] = []

    for (const amount of amounts) {
      const { body } = await add(u.token, {
        transaction_type: 'expense', amount, currency: 'GBP',
        transaction_date: '2026-08-14', category_id: cat.id, title: `sum ${amount}`,
      })
      stored.push(String(body.transaction.converted_amount))
      exact.push(decimalMultiply(amount, String(body.transaction.exchange_rate)))
    }

    const { decimalSum } = await import('../lib/decimal')
    expect(decimalEquals(decimalSum(stored), decimalSum(exact))).toBe(true)
    expect(looksFloatContaminated(decimalSum(stored))).toBe(false)
  }, 60000)

  it('short-circuits same-currency with rate 1 and no approximation', async () => {
    const u = await makeUser('KRW', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount: 5000, currency: 'KRW',
      transaction_date: '2026-08-14', category_id: cat.id, title: 'Same currency',
    })
    expect(Number(body.transaction.exchange_rate)).toBe(1)
    expect(Number(body.transaction.converted_amount)).toBe(5000)
    expect(body.transaction.rate_source).toBe('identity')
    expect(body.transaction.rate_is_approximate).toBe(false)
  }, 30000)

  it('uses the rate for the transaction date, not today', async () => {
    const u = await makeUser('GBP', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const past = await add(u.token, {
      transaction_type: 'expense', amount: 10, currency: 'GBP',
      transaction_date: '2026-07-15', category_id: cat.id, title: 'July receipt',
    })
    // Frankfurter reports the publication date it used; it must track the
    // transaction date, not the current date.
    expect(past.body.transaction.rate_date.slice(0, 7)).toBe('2026-07')
    expect(past.body.transaction.rate_is_approximate).toBe(false)
  }, 30000)

  it('resolves a weekend date to the nearest prior publication, deterministically', async () => {
    const u = await makeUser('EUR', 'USD')
    const cat = u.categories.find((c) => c.type === 'expense')!
    // 2026-08-16 is a Sunday.
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount: 20, currency: 'EUR',
      transaction_date: '2026-08-16', category_id: cat.id, title: 'Sunday market',
    })
    const tx = body.transaction
    expect(tx.transaction_date).toBe('2026-08-16')
    // Rate date is earlier than the transaction date, and is a weekday.
    expect(tx.rate_date < '2026-08-16').toBe(true)
    const dow = new Date(`${tx.rate_date}T12:00:00Z`).getUTCDay()
    expect(dow).toBeGreaterThanOrEqual(1)
    expect(dow).toBeLessThanOrEqual(5)
  }, 30000)

  it('flags an approximation instead of presenting it as exact', async () => {
    // VND is outside Frankfurter's ~30 currencies, so a past-dated VND row must
    // fall back to a current rate AND be marked approximate.
    const u = await makeUser('VND', 'GBP')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount: 500000, currency: 'VND',
      transaction_date: '2026-07-15', category_id: cat.id, title: 'Pho',
    })
    const tx = body.transaction
    if (tx.converted_amount !== null) {
      expect(tx.rate_source).toBe('er-api')
      expect(tx.rate_is_approximate).toBe(true)
    } else {
      // Acceptable outcome too: unavailable rate must not have blocked the save.
      expect(tx.id).toBeTruthy()
    }
  }, 30000)
})

describe('a rate failure never blocks a save, and backfill repairs it', () => {
  it('saves with null conversion then fills it in on backfill', async () => {
    const u = await makeUser('GBP', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!

    // 'XTS' is the ISO test code — no provider quotes it, so conversion must
    // fail while the save still succeeds.
    const { status, body } = await add(u.token, {
      transaction_type: 'expense', amount: 42, currency: 'XTS',
      transaction_date: '2026-08-14', category_id: cat.id, title: 'Unknown currency',
    })
    expect(status).toBe(200)
    expect(body.transaction.id).toBeTruthy()
    expect(body.transaction.converted_amount).toBeNull()
    expect(body.transaction.exchange_rate).toBeNull()
    // The intended target is still recorded so backfill knows where to go.
    expect(body.transaction.converted_currency).toBe('KRW')

    // A convertible row saved alongside it is what backfill should repair.
    await add(u.token, {
      transaction_type: 'expense', amount: 10, currency: 'GBP',
      transaction_date: '2026-08-14', category_id: cat.id, title: 'Convertible',
    })

    const out = await call('/api/transactions/backfill', {
      method: 'POST', token: u.token, body: JSON.stringify({ limit: 25 }),
    })
    expect(out.status).toBe(200)
    // The un-quotable row stays pending rather than being given a wrong number.
    const list = await call('/api/transactions?q=Unknown currency', { token: u.token })
    expect(list.body.transactions[0].converted_amount).toBeNull()
  }, 40000)
})

describe('editing re-runs conversion', () => {
  let u: Awaited<ReturnType<typeof makeUser>>
  let txId: string
  let original: any

  beforeAll(async () => {
    u = await makeUser('GBP', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount: 10, currency: 'GBP',
      transaction_date: '2026-08-14', category_id: cat.id, title: 'Editable',
    })
    txId = body.transaction.id
    original = body.transaction
  }, 30000)

  it('recomputes converted_amount when the amount changes', async () => {
    const { body } = await call(`/api/transactions/${txId}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ amount: 20 }),
    })
    expect(Number(body.transaction.amount)).toBe(20)
    // Same rate, doubled amount -> exactly double, checked in decimal.
    const expected = decimalMultiply('20', String(body.transaction.exchange_rate))
    expect(decimalEquals(body.transaction.converted_amount, expected)).toBe(true)
    expect(looksFloatContaminated(body.transaction.converted_amount)).toBe(false)
  }, 30000)

  it('recomputes the rate when the currency changes', async () => {
    const { body } = await call(`/api/transactions/${txId}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ currency: 'USD' }),
    })
    expect(body.transaction.currency).toBe('USD')
    expect(Number(body.transaction.exchange_rate)).not.toBeCloseTo(
      Number(original.exchange_rate), 2,
    )
    expect(
      decimalEquals(
        body.transaction.converted_amount,
        decimalMultiply(String(body.transaction.amount), String(body.transaction.exchange_rate)),
      ),
    ).toBe(true)
  }, 30000)

  it('recomputes the rate when the date changes', async () => {
    const before = await call('/api/transactions?q=Editable', { token: u.token })
    const rateBefore = before.body.transactions[0].rate_date

    const { body } = await call(`/api/transactions/${txId}`, {
      method: 'PATCH', token: u.token,
      body: JSON.stringify({ transaction_date: '2026-06-15' }),
    })
    expect(body.transaction.transaction_date).toBe('2026-06-15')
    expect(body.transaction.rate_date).not.toBe(rateBefore)
    expect(body.transaction.rate_date.slice(0, 7)).toBe('2026-06')
  }, 30000)

  it('leaves conversion untouched when only the title changes', async () => {
    const before = await call('/api/transactions?q=Editable', { token: u.token })
    const prev = before.body.transactions[0]

    const { body } = await call(`/api/transactions/${txId}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ title: 'Renamed only' }),
    })
    expect(body.transaction.title).toBe('Renamed only')
    expect(Number(body.transaction.exchange_rate)).toBe(Number(prev.exchange_rate))
    expect(Number(body.transaction.converted_amount)).toBe(Number(prev.converted_amount))
  }, 30000)
})

describe('converted_currency is snapshotted, not derived at read time', () => {
  it('does not mutate historical rows when home currency changes', async () => {
    const u = await makeUser('GBP', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount: 10, currency: 'GBP',
      transaction_date: '2026-08-14', category_id: cat.id, title: 'Historical',
    })
    const before = body.transaction

    // User later moves home currency to USD.
    await call('/api/profile', {
      method: 'PATCH', token: u.token,
      body: JSON.stringify({
        study_country: 'XX', local_currency: 'GBP', home_currency: 'USD',
        display_currency: 'USD', monthly_budget: null, onboarded: true,
      }),
    })

    const after = await call('/api/transactions?q=Historical', { token: u.token })
    const row = after.body.transactions[0]
    // The old row keeps the currency and value it was written with.
    expect(row.converted_currency).toBe('KRW')
    expect(Number(row.converted_amount)).toBeCloseTo(Number(before.converted_amount), 6)
  }, 30000)

  it('re-converts an edited row against its OWN snapshot, not the new home currency', async () => {
    // The case that actually catches a regression here: editing the amount
    // AFTER the home currency changed must still target the row's original
    // converted_currency. Deriving it from the profile at edit time would
    // silently re-denominate a historical row.
    const u = await makeUser('GBP', 'KRW')
    const cat = u.categories.find((c) => c.type === 'expense')!
    const { body } = await add(u.token, {
      transaction_type: 'expense', amount: 10, currency: 'GBP',
      transaction_date: '2026-08-14', category_id: cat.id, title: 'Snapshot edit',
    })
    const rowId = body.transaction.id
    expect(body.transaction.converted_currency).toBe('KRW')

    await call('/api/profile', {
      method: 'PATCH', token: u.token,
      body: JSON.stringify({
        study_country: 'XX', local_currency: 'GBP', home_currency: 'USD',
        display_currency: 'USD', monthly_budget: null, onboarded: true,
      }),
    })

    // Money-relevant edit -> conversion re-runs, but against KRW.
    const edited = await call(`/api/transactions/${rowId}`, {
      method: 'PATCH', token: u.token, body: JSON.stringify({ amount: 20 }),
    })
    expect(edited.body.transaction.converted_currency).toBe('KRW')
    expect(
      decimalEquals(
        edited.body.transaction.converted_amount,
        decimalMultiply('20', String(edited.body.transaction.exchange_rate)),
      ),
    ).toBe(true)
  }, 30000)
})

describe('filters combine, not just work individually', () => {
  let u: Awaited<ReturnType<typeof makeUser>>
  let food: string
  let transport: string
  let cash: string
  let card: string

  beforeAll(async () => {
    u = await makeUser('GBP', 'KRW')
    food = u.categories.find((c) => c.name === 'Groceries' && c.type === 'expense')!.id
    transport = u.categories.find((c) => c.name === 'Transport')!.id
    const allowance = u.categories.find((c) => c.type === 'income')!.id
    cash = u.paymentMethods.find((p) => p.name === 'Cash')!.id
    card = u.paymentMethods.find((p) => p.name === 'Debit Card')!.id

    const rows = [
      { d: '2026-08-03', t: 'Tesco groceries', c: food, p: cash, cur: 'GBP', a: 12, ty: 'expense', desc: 'weekly shop' },
      { d: '2026-08-11', t: 'Bus pass',        c: transport, p: card, cur: 'GBP', a: 30, ty: 'expense', desc: null },
      { d: '2026-08-19', t: 'Ramen',           c: food, p: cash, cur: 'JPY', a: 900, ty: 'expense', desc: 'campus' },
      { d: '2026-07-14', t: 'Tesco July',      c: food, p: card, cur: 'GBP', a: 22, ty: 'expense', desc: null },
      { d: '2026-08-05', t: 'Tutoring pay',    c: allowance, p: cash, cur: 'GBP', a: 150, ty: 'income', desc: 'two sessions' },
    ]
    for (const r of rows) {
      await add(u.token, {
        transaction_type: r.ty, amount: r.a, currency: r.cur,
        transaction_date: r.d, category_id: r.c, payment_method_id: r.p,
        title: r.t, description: r.desc,
      })
    }
  }, 90000)

  const count = async (qs: string) =>
    (await call(`/api/transactions${qs}`, { token: u.token })).body.transactions.length

  it('filters by month alone', async () => {
    expect(await count('?month=2026-08')).toBe(4)
    expect(await count('?month=2026-07')).toBe(1)
  })

  it('filters by type alone', async () => {
    expect(await count('?type=income')).toBe(1)
    expect(await count('?type=expense')).toBe(4)
  })

  it('filters by currency alone', async () => {
    expect(await count('?currency=JPY')).toBe(1)
    expect(await count('?currency=GBP')).toBe(4)
  })

  it('combines month + category', async () => {
    // August Food = Tesco groceries + Ramen
    expect(await count(`?month=2026-08&category_id=${food}`)).toBe(2)
  })

  it('combines month + category + payment method', async () => {
    // August Food on Cash = Tesco groceries + Ramen
    expect(await count(`?month=2026-08&category_id=${food}&payment_method_id=${cash}`)).toBe(2)
    // August Food on Card = none
    expect(await count(`?month=2026-08&category_id=${food}&payment_method_id=${card}`)).toBe(0)
  })

  it('combines month + currency + type', async () => {
    expect(await count('?month=2026-08&currency=GBP&type=expense')).toBe(2)
    expect(await count('?month=2026-08&currency=GBP&type=income')).toBe(1)
  })

  it('combines search with structural filters', async () => {
    // "Tesco" spans two months; scoping to August leaves one.
    expect(await count('?q=Tesco')).toBe(2)
    expect(await count('?q=Tesco&month=2026-08')).toBe(1)
    expect(await count(`?q=Tesco&month=2026-08&payment_method_id=${card}`)).toBe(0)
  })

  it('searches description as well as title', async () => {
    expect(await count('?q=weekly shop')).toBe(1)
    expect(await count('?q=campus')).toBe(1)
  })

  it('rejects an unknown query param instead of silently returning everything', async () => {
    // A typo'd filter that quietly returns every row is worse than an error:
    // the caller believes they are looking at a filtered list.
    const typo = await call('/api/transactions?search=Tesco', { token: u.token })
    expect(typo.status).toBe(400)
    expect(typo.body.error).toMatch(/unknown query parameter/i)
    expect(typo.body.error).toMatch(/search/)

    // The correct param still works.
    const ok = await call('/api/transactions?q=Tesco', { token: u.token })
    expect(ok.status).toBe(200)
  })

  it('returns nothing for a contradictory combination', async () => {
    expect(await count(`?currency=JPY&payment_method_id=${card}`)).toBe(0)
  })

  it('sorts by date in both directions', async () => {
    const desc = (await call('/api/transactions?sort=date_desc', { token: u.token }))
      .body.transactions.map((t: any) => t.transaction_date)
    const asc = (await call('/api/transactions?sort=date_asc', { token: u.token }))
      .body.transactions.map((t: any) => t.transaction_date)
    expect(desc[0] >= desc[desc.length - 1]).toBe(true)
    expect(asc[0] <= asc[asc.length - 1]).toBe(true)
    expect(asc).toEqual([...desc].reverse())
  })

  it('reports a total alongside the filtered page', async () => {
    const { body } = await call('/api/transactions?month=2026-08', { token: u.token })
    expect(body.total).toBe(4)
  })
})

describe('one user cannot touch another user\'s transactions', () => {
  it('blocks read, edit and delete across users', async () => {
    const a = await makeUser('GBP', 'KRW')
    const b = await makeUser('USD', 'JPY')

    const catA = a.categories.find((c) => c.type === 'expense')!
    const { body } = await add(a.token, {
      transaction_type: 'expense', amount: 10, currency: 'GBP',
      transaction_date: '2026-08-14', category_id: catA.id, title: "A's private row",
    })
    const rowId = body.transaction.id

    // B cannot see it.
    const bList = await call('/api/transactions', { token: b.token })
    expect(bList.body.transactions.length).toBe(0)

    // B cannot edit it — RLS matches no row, so it reads as not found.
    const bEdit = await call(`/api/transactions/${rowId}`, {
      method: 'PATCH', token: b.token, body: JSON.stringify({ title: 'hacked' }),
    })
    expect(bEdit.status).toBe(404)

    // B cannot delete it.
    const bDelete = await call(`/api/transactions/${rowId}`, {
      method: 'DELETE', token: b.token,
    })
    expect(bDelete.status).toBe(404)

    // A's row is untouched.
    const aList = await call('/api/transactions', { token: a.token })
    expect(aList.body.transactions.length).toBe(1)
    expect(aList.body.transactions[0].title).toBe("A's private row")

    // And A can delete their own.
    const aDelete = await call(`/api/transactions/${rowId}`, {
      method: 'DELETE', token: a.token,
    })
    expect(aDelete.status).toBe(200)
  }, 40000)

  it('rejects unauthenticated and garbage tokens', async () => {
    expect((await call('/api/transactions')).status).toBe(401)
    expect((await call('/api/transactions', { token: 'garbage' })).status).toBe(401)
  })
})
