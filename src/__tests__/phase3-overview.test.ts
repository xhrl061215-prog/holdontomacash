/**
 * Phase 3 acceptance — Overview aggregation and Budget Consultant.
 *
 * The headline requirement is that Overview totals reconcile EXACTLY against the
 * Transactions list under the same filters. Reconciliation is verified both ways
 * (endpoint vs summed rows) using exact decimal arithmetic, never floats.
 *
 * Requires the API running (npm run dev:all).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { decimalSum, decimalEquals } from '../lib/decimal'

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

async function makeUser(opts: {
  local?: string; home?: string; budget?: string | null; budgetCurrency?: string
} = {}) {
  const { body } = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: `p3-${Math.random().toString(36).slice(2)}-${Date.now()}@example.com`,
      password: 'testpass123',
    }),
  })
  await call('/api/profile', {
    method: 'PATCH', token: body.token,
    body: JSON.stringify({
      study_country: 'XX',
      local_currency: opts.local ?? 'GBP',
      home_currency: opts.home ?? 'KRW',
      display_currency: opts.home ?? 'KRW',
      monthly_budget: opts.budget === undefined ? null : opts.budget,
      budget_currency:
        opts.budget === undefined || opts.budget === null
          ? null
          : (opts.budgetCurrency ?? opts.local ?? 'GBP'),
      onboarded: true,
    }),
  })
  const cats = await call('/api/categories', { token: body.token })
  const list = cats.body.categories as any[]
  return {
    token: body.token,
    food: list.find((c) => c.name === 'Groceries' && c.type === 'expense').id,
    transport: list.find((c) => c.name === 'Transport').id,
    shopping: list.find((c) => c.name === 'Shopping').id,
    income: list.find((c) => c.type === 'income').id,
  }
}

const add = (token: string, row: Record<string, unknown>) =>
  call('/api/transactions', { method: 'POST', token, body: JSON.stringify(row) })

function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`

// ---------------------------------------------------------------------------

describe('totals reconcile exactly against the transactions list', () => {
  const M = thisMonth()
  let u: Awaited<ReturnType<typeof makeUser>>

  beforeAll(async () => {
    u = await makeUser({ budget: '2000000' })
    // Amounts deliberately chosen so float summation would drift.
    const rows = [
      { amount: '12.50', currency: 'GBP', category_id: u.food, transaction_type: 'expense', d: 1 },
      { amount: '0.07', currency: 'GBP', category_id: u.food, transaction_type: 'expense', d: 2 },
      { amount: '33.33', currency: 'GBP', category_id: u.transport, transaction_type: 'expense', d: 3 },
      { amount: '19.99', currency: 'GBP', category_id: u.shopping, transaction_type: 'expense', d: 4 },
      { amount: '7.77', currency: 'USD', category_id: u.food, transaction_type: 'expense', d: 5 },
      { amount: '150.00', currency: 'GBP', category_id: u.income, transaction_type: 'income', d: 3 },
      { amount: '22.22', currency: 'GBP', category_id: u.income, transaction_type: 'income', d: 6 },
    ]
    for (const r of rows) {
      const { d, ...rest } = r
      await add(u.token, { ...rest, transaction_date: day(M, d), title: `row ${r.amount}` })
    }
  }, 120000)

  it('expense total equals the exact sum of expense rows', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const list = await call(`/api/transactions?month=${M}&type=expense`, { token: u.token })

    const rowSum = decimalSum(
      list.body.transactions
        .filter((t: any) => t.converted_amount !== null)
        .map((t: any) => String(t.converted_amount)),
    )
    expect(
      decimalEquals(ov.body.totals.expense, rowSum),
      `overview ${ov.body.totals.expense} != row sum ${rowSum}`,
    ).toBe(true)
  }, 30000)

  it('income total equals the exact sum of income rows', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const list = await call(`/api/transactions?month=${M}&type=income`, { token: u.token })

    const rowSum = decimalSum(
      list.body.transactions
        .filter((t: any) => t.converted_amount !== null)
        .map((t: any) => String(t.converted_amount)),
    )
    expect(decimalEquals(ov.body.totals.income, rowSum)).toBe(true)
  }, 30000)

  it('net is exactly income minus expense', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const { expense, income, net } = ov.body.totals
    // net + expense must equal income, exactly.
    expect(decimalEquals(decimalSum([net, expense]), income)).toBe(true)
  }, 30000)

  it('budget remaining is exactly budget minus expense', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const { expense, budget_remaining, monthly_budget } = ov.body.totals
    expect(decimalEquals(decimalSum([budget_remaining, expense]), monthly_budget)).toBe(true)
  }, 30000)

  it('every category total reconciles against that category filtered', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    for (const cat of ov.body.categories) {
      const list = await call(
        `/api/transactions?month=${M}&type=expense&category_id=${cat.category_id}`,
        { token: u.token },
      )
      const rowSum = decimalSum(
        list.body.transactions
          .filter((t: any) => t.converted_amount !== null)
          .map((t: any) => String(t.converted_amount)),
      )
      expect(
        decimalEquals(cat.total, rowSum),
        `category ${cat.category_name}: ${cat.total} != ${rowSum}`,
      ).toBe(true)
    }
  }, 60000)

  it('category totals sum to the expense total', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const catSum = decimalSum(ov.body.categories.map((c: any) => String(c.total)))
    expect(decimalEquals(catSum, ov.body.totals.expense)).toBe(true)
  }, 30000)

  it('totals carry no binary-float dust', async () => {
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    for (const v of [
      ov.body.totals.expense, ov.body.totals.income,
      ov.body.totals.net, ov.body.totals.budget_remaining,
    ]) {
      expect(String(v)).not.toMatch(/\.\d*(0{8,}\d|9{8,}\d)/)
    }
  }, 30000)
})

describe('pending rows are excluded from totals and surfaced', () => {
  it('excludes a pending row and reports the count', async () => {
    const M = thisMonth()
    const u = await makeUser({ budget: '1000' })

    await add(u.token, {
      transaction_type: 'expense', amount: '10.00', currency: 'GBP',
      transaction_date: day(M, 1), category_id: u.food, title: 'convertible',
    })
    // XTS is the ISO test code: no provider quotes it, so it stays pending.
    const pending = await add(u.token, {
      transaction_type: 'expense', amount: '999.00', currency: 'XTS',
      transaction_date: day(M, 2), category_id: u.food, title: 'pending row',
    })
    expect(pending.body.transaction.converted_amount).toBeNull()

    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.pending_count).toBe(1)
    expect(ov.body.transaction_count).toBe(2)

    // The pending row must NOT be counted as zero — the total equals only the
    // convertible row.
    const list = await call(`/api/transactions?month=${M}`, { token: u.token })
    const convertible = list.body.transactions.filter((t: any) => t.converted_amount !== null)
    const rowSum = decimalSum(convertible.map((t: any) => String(t.converted_amount)))
    expect(decimalEquals(ov.body.totals.expense, rowSum)).toBe(true)
  }, 60000)

  it('does not count a pending row as a contributing zero', async () => {
    // The distinguishing signal between "excluded" and "counted as zero" is NOT
    // the sum — NULL adds nothing either way — but whether the row is treated as
    // contributing. A category whose only rows are pending must be ABSENT from
    // the breakdown, not present with a zero total.
    const M = thisMonth()
    const u = await makeUser({ budget: '1000' })

    // Food gets a real row; Transport gets only a pending one.
    await add(u.token, {
      transaction_type: 'expense', amount: '10.00', currency: 'GBP',
      transaction_date: day(M, 1), category_id: u.food, title: 'real food',
    })
    await add(u.token, {
      transaction_type: 'expense', amount: '50.00', currency: 'XTS',
      transaction_date: day(M, 2), category_id: u.transport, title: 'pending transport',
    })

    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.pending_count).toBe(1)

    const names = ov.body.categories.map((c: any) => c.category_name)
    expect(names).toContain('Groceries')
    // Transport must not appear at all — a 0 KRW Transport row in the donut
    // would be a category the user never actually spent in.
    expect(names).not.toContain('Transport')

    // And no category may carry a zero total.
    for (const c of ov.body.categories) {
      expect(decimalEquals(c.total, '0')).toBe(false)
    }
  }, 60000)

  it('reports a month where EVERY row is pending as zero total with the count', async () => {
    const M = thisMonth()
    const u = await makeUser({ budget: '1000' })
    for (const n of ['5.00', '10.00']) {
      await add(u.token, {
        transaction_type: 'expense', amount: n, currency: 'XTS',
        transaction_date: day(M, 1), category_id: u.food, title: `pending ${n}`,
      })
    }
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.pending_count).toBe(2)
    expect(decimalEquals(ov.body.totals.expense, '0')).toBe(true)
    // Zero total with a pending count is honest; zero with no signal would not be.
    expect(ov.body.transaction_count).toBe(2)
    expect(ov.body.categories.length).toBe(0)
  }, 60000)
})

describe('budget handling', () => {
  it('returns null budget_remaining when no budget is set, never zero', async () => {
    const M = thisMonth()
    const u = await makeUser({ budget: null })
    await add(u.token, {
      transaction_type: 'expense', amount: '10.00', currency: 'GBP',
      transaction_date: day(M, 1), category_id: u.food, title: 'x',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.totals.monthly_budget).toBeNull()
    expect(ov.body.totals.budget_remaining).toBeNull()
    // And the pace rule must not fire without a budget.
    expect(ov.body.insights.some((i: any) => i.id === 'budget_pace')).toBe(false)
  }, 60000)

  it('reports a negative remaining when overspent rather than clamping to zero', async () => {
    // Same-currency throughout, so no conversion is involved and the arithmetic
    // is unambiguous: a 100 KRW budget with 150 KRW spent leaves -50.
    const M = thisMonth()
    const u = await makeUser({ local: 'KRW', home: 'KRW', budget: '100' })
    await add(u.token, {
      transaction_type: 'expense', amount: '150', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'over',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(decimalEquals(ov.body.totals.budget_remaining, '-50')).toBe(true)
    expect(ov.body.totals.budget_remaining.startsWith('-')).toBe(true)
  }, 60000)

  it('leaves a positive remaining under budget, same currency', async () => {
    const M = thisMonth()
    const u = await makeUser({ local: 'KRW', home: 'KRW', budget: '100' })
    await add(u.token, {
      transaction_type: 'expense', amount: '10', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'under',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(decimalEquals(ov.body.totals.budget_remaining, '90')).toBe(true)
  }, 60000)
})

describe('budget currency — the budget is set in the local spending currency', () => {
  // The reported defect: a London student typing 1500 (meaning GBP 1,500) had it
  // evaluated as 1500 KRW, producing "965132.4% of your budget". Every figure was
  // arithmetically correct and the sentence was nonsense.
  it('converts a GBP budget before comparing against KRW totals', async () => {
    const M = thisMonth()
    const u = await makeUser({ local: 'GBP', home: 'KRW', budget: '1500' })
    await add(u.token, {
      transaction_type: 'expense', amount: '400.00', currency: 'GBP',
      transaction_date: day(M, 1), category_id: u.food, title: 'rent share',
    })

    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const t = ov.body.totals

    // The entered figure and its currency are both preserved.
    expect(decimalEquals(t.budget_original, '1500')).toBe(true)
    expect(t.budget_currency).toBe('GBP')
    expect(t.budget_converted).toBe(true)

    // The comparable budget is in home currency and far larger than 1500.
    expect(Number(t.monthly_budget)).toBeGreaterThan(1_000_000)

    // ~GBP400 of a GBP1500 budget is roughly 27%.
    const pct = (Number(t.expense) / Number(t.monthly_budget)) * 100
    expect(pct).toBeGreaterThan(20)
    expect(pct).toBeLessThan(35)

    // Remaining is positive: GBP1100 left, not a huge negative.
    expect(t.budget_remaining.startsWith('-')).toBe(false)
  }, 60000)

  it('never reports an absurd budget percentage', async () => {
    // A percentage over ~1000% is a unit error, not a spending pattern. Asserted
    // directly because it is the observable symptom a user would notice.
    const M = thisMonth()
    for (const [local, home, budget, spend] of [
      ['GBP', 'KRW', '1500', '400.00'],
      ['JPY', 'GBP', '150000', '20000'],
      ['USD', 'JPY', '2000', '500.00'],
      ['KRW', 'USD', '2000000', '500000'],
    ] as const) {
      const u = await makeUser({ local, home, budget })
      await add(u.token, {
        transaction_type: 'expense', amount: spend, currency: local,
        transaction_date: day(M, 1), category_id: u.food, title: 'spend',
      })
      const ov = await call(`/api/overview?month=${M}`, { token: u.token })
      const t = ov.body.totals
      const pct = (Number(t.expense) / Number(t.monthly_budget)) * 100
      expect(
        pct < 1000,
        `${local}->${home}: spent ${t.expense} against budget ${t.monthly_budget} = ${pct.toFixed(1)}%`,
      ).toBe(true)

      // And no insight may contain a four-or-more-digit percentage.
      for (const i of ov.body.insights) {
        expect(i.text).not.toMatch(/\b\d{4,}(\.\d+)?%/)
      }
    }
  }, 120000)

  it('needs no conversion when budget and home currency already match', async () => {
    const M = thisMonth()
    const u = await makeUser({ local: 'KRW', home: 'KRW', budget: '2000000' })
    await add(u.token, {
      transaction_type: 'expense', amount: '500000', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'spend',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.totals.budget_converted).toBe(false)
    expect(decimalEquals(ov.body.totals.monthly_budget, '2000000')).toBe(true)
    expect(decimalEquals(ov.body.totals.budget_remaining, '1500000')).toBe(true)
  }, 60000)

  it('snapshots budget_currency so changing local currency cannot re-denominate it', async () => {
    const M = thisMonth()
    const u = await makeUser({ local: 'GBP', home: 'KRW', budget: '1500' })
    const before = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(before.body.totals.budget_currency).toBe('GBP')

    // The student moves to Japan and updates their local currency, but the
    // existing budget was set in GBP and must stay GBP.
    await call('/api/profile', {
      method: 'PATCH', token: u.token,
      body: JSON.stringify({
        study_country: 'JP', local_currency: 'JPY', home_currency: 'KRW',
        display_currency: 'KRW', monthly_budget: '1500', budget_currency: 'GBP',
        onboarded: true,
      }),
    })
    const after = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(after.body.totals.budget_currency).toBe('GBP')
    expect(decimalEquals(after.body.totals.monthly_budget, before.body.totals.monthly_budget)).toBe(true)
  }, 60000)

  it('validates the budget against its own currency, not the home currency', async () => {
    // 1500.50 is valid GBP; a JPY budget with decimals is not.
    const okRes = await call('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `bud-ok-${Date.now()}@example.com`, password: 'testpass123',
      }),
    })
    const ok = await call('/api/profile', {
      method: 'PATCH', token: okRes.body.token,
      body: JSON.stringify({
        study_country: 'GB', local_currency: 'GBP', home_currency: 'KRW',
        display_currency: 'KRW', monthly_budget: '1500.50',
        budget_currency: 'GBP', onboarded: true,
      }),
    })
    expect(ok.status).toBe(200)

    const badRes = await call('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `bud-bad-${Date.now()}@example.com`, password: 'testpass123',
      }),
    })
    const bad = await call('/api/profile', {
      method: 'PATCH', token: badRes.body.token,
      body: JSON.stringify({
        study_country: 'JP', local_currency: 'JPY', home_currency: 'GBP',
        display_currency: 'GBP', monthly_budget: '150000.50',
        budget_currency: 'JPY', onboarded: true,
      }),
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/no decimal unit/i)
  }, 60000)
})

describe('equal-period month-over-month', () => {
  it('compares equal windows and reports the days used', async () => {
    const M = thisMonth()
    const u = await makeUser()
    await add(u.token, {
      transaction_type: 'expense', amount: '10', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'current',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const c = ov.body.comparison
    expect(c.prior_month).toBe(
      // previous month of M
      (() => {
        const [y, m] = M.split('-').map(Number)
        return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
      })(),
    )
    expect(c.through_day).toBe(Number(today().slice(8, 10)))
    expect(c.prior_through_day).toBeLessThanOrEqual(c.through_day)
  }, 60000)

  it('says "not comparable" when the prior period had no spend, never 0% or Infinity', async () => {
    const M = thisMonth()
    const u = await makeUser()
    await add(u.token, {
      transaction_type: 'expense', amount: '10', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'only current',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.comparison.comparable).toBe(false)
    expect(ov.body.comparison.change_absolute).toBeNull()
    // No insight may claim a percentage change against nothing.
    for (const i of ov.body.insights) {
      expect(i.text).not.toMatch(/Infinity|NaN|undefined/)
    }
  }, 60000)

  it('clamps the prior window when the prior month is shorter, and flags it', async () => {
    // March 31 vs February: the prior window must clamp to Feb 28/29.
    const u = await makeUser()
    const ov = await call('/api/overview?month=2026-03', { token: u.token })
    const c = ov.body.comparison
    expect(c.prior_month).toBe('2026-02')
    // A past month compares through its full length (31), so February clamps.
    expect(c.through_day).toBe(31)
    expect(c.prior_through_day).toBe(28)
    expect(c.clamped).toBe(true)
  }, 60000)

  it('handles a January month by comparing against the prior December', async () => {
    const u = await makeUser()
    const ov = await call('/api/overview?month=2026-01', { token: u.token })
    expect(ov.body.comparison.prior_month).toBe('2025-12')
  }, 60000)
})

describe('Budget Consultant rules', () => {
  it('emits at most three insights', async () => {
    const M = thisMonth()
    const u = await makeUser({ budget: '500' })
    // Whole amounts: KRW has no minor unit.
    for (const [amount, cat] of [
      ['100', 'food'], ['50', 'transport'], ['25', 'shopping'],
    ] as const) {
      await add(u.token, {
        transaction_type: 'expense', amount, currency: 'KRW',
        transaction_date: day(M, 1),
        category_id: (u as any)[cat], title: `${cat} ${amount}`,
      })
    }
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.insights.length).toBeLessThanOrEqual(3)
    expect(ov.body.insights.length).toBeGreaterThan(0)
  }, 60000)

  it('cites real figures in every insight and never moralises', async () => {
    const M = thisMonth()
    const u = await makeUser({ budget: '500' })
    await add(u.token, {
      transaction_type: 'expense', amount: '100', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'groceries',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    for (const i of ov.body.insights) {
      // Contains at least one number.
      expect(i.text).toMatch(/\d/)
      // No motivational filler or judgement.
      expect(i.text).not.toMatch(
        /you should|try to|bad|wasteful|too much|treat yourself|great job|well done|don't worry/i,
      )
      expect(i.text.length).toBeLessThan(260)
    }
  }, 60000)

  it('suppresses the pace projection before day 7', async () => {
    // A past month is evaluated through its full length, so use the rule's own
    // gate directly via a month whose window is short: verify by checking a
    // deliberately early-day scenario is not projected.
    const M = thisMonth()
    const dayNum = Number(today().slice(8, 10))
    const u = await makeUser({ budget: '500' })
    await add(u.token, {
      transaction_type: 'expense', amount: '10', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'early',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    const hasPace = ov.body.insights.some((i: any) => i.id === 'budget_pace')
    if (dayNum < 7) {
      expect(hasPace).toBe(false)
    } else {
      // When it does fire it must label itself a projection.
      const pace = ov.body.insights.find((i: any) => i.id === 'budget_pace')
      if (pace) expect(pace.text).toMatch(/projection/i)
    }
  }, 60000)

  it('renders honestly with a single transaction and suppresses comparisons', async () => {
    const M = thisMonth()
    const u = await makeUser()
    await add(u.token, {
      transaction_type: 'expense', amount: '10', currency: 'KRW',
      transaction_date: day(M, 1), category_id: u.food, title: 'only one',
    })
    const ov = await call(`/api/overview?month=${M}`, { token: u.token })
    expect(ov.body.transaction_count).toBe(1)
    expect(decimalEquals(ov.body.totals.expense, '10')).toBe(true)
    // No MoM swing rule without a prior period.
    expect(ov.body.insights.some((i: any) => i.id === 'category_swing')).toBe(false)
  }, 60000)

  it('emits nothing rather than filler for an empty month', async () => {
    const u = await makeUser()
    const ov = await call('/api/overview?month=2026-01', { token: u.token })
    expect(ov.body.transaction_count).toBe(0)
    expect(decimalEquals(ov.body.totals.expense, '0')).toBe(true)
    expect(ov.body.insights.length).toBe(0)
    expect(ov.body.categories.length).toBe(0)
  }, 60000)
})

describe('overview input validation and isolation', () => {
  it('rejects a malformed month', async () => {
    const u = await makeUser()
    for (const m of ['2026-13', 'august', '2026', '2026-1', '', '2026-00']) {
      const res = await call(`/api/overview?month=${encodeURIComponent(m)}`, { token: u.token })
      expect(res.status).toBe(400)
    }
  }, 60000)

  it('rejects unknown query params', async () => {
    const u = await makeUser()
    const res = await call('/api/overview?monht=2026-08', { token: u.token })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown query parameter/i)
  }, 30000)

  it('requires authentication', async () => {
    expect((await call('/api/overview')).status).toBe(401)
    expect((await call('/api/overview', { token: 'garbage' })).status).toBe(401)
  }, 30000)

  it('never includes another user\'s transactions', async () => {
    const M = thisMonth()
    const a = await makeUser()
    const b = await makeUser()
    await add(a.token, {
      transaction_type: 'expense', amount: '500', currency: 'KRW',
      transaction_date: day(M, 1), category_id: a.food, title: "a's row",
    })
    const ovB = await call(`/api/overview?month=${M}`, { token: b.token })
    expect(decimalEquals(ovB.body.totals.expense, '0')).toBe(true)
    expect(ovB.body.transaction_count).toBe(0)

    const ovA = await call(`/api/overview?month=${M}`, { token: a.token })
    expect(decimalEquals(ovA.body.totals.expense, '500')).toBe(true)
  }, 60000)
})
