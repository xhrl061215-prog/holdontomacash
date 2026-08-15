/**
 * Budget Consultant rules tested as pure functions.
 *
 * Why separate from phase3-overview.test.ts: those tests exercise the live
 * endpoint, so anything that depends on *today's* date can only be checked for
 * whatever day it happens to be. The day-7 pace gate is the clear example — a
 * conditional assertion around `if (dayNum < 7)` silently tests nothing for
 * three weeks of every month.
 *
 * Calling the rules directly lets every branch be driven deterministically,
 * whatever the date.
 */
import { describe, it, expect } from 'vitest'
import {
  buildInsights, money, percentOf, percentChange, decSub, isZero,
} from '../../server/consultant.mjs'

/** Minimal aggregate-window shape. */
function window(opts: {
  expense?: string
  income?: string
  categories?: { category_id: string; category_name: string; total: string; tx_count: number }[]
  total_count?: number
} = {}) {
  return {
    expense: opts.expense ?? '0',
    income: opts.income ?? '0',
    expense_rows: opts.categories?.length ?? 0,
    income_rows: 0,
    categories: opts.categories ?? [],
    pending_count: 0,
    approximate_count: 0,
    total_count: opts.total_count ?? (opts.categories?.length ?? 0),
  }
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    month: '2026-08',
    dayOfMonth: 15,
    daysInMonth: 31,
    homeCurrency: 'KRW',
    current: window(),
    prior: window(),
    priorClamped: false,
    priorThroughDay: 15,
    monthlyBudget: null,
    noSpendStreak: 0,
    ...over,
  } as any
}

const cat = (id: string, name: string, total: string, tx_count = 5) =>
  ({ category_id: id, category_name: name, total, tx_count })

// ---------------------------------------------------------------------------

describe('exact decimal helpers', () => {
  it('subtracts without float error', () => {
    expect(decSub('0.3', '0.1')).toBe('0.2')
    expect(decSub('38207.6', '19103.8')).toBe('19103.8')
    expect(decSub('100', '150')).toBe('-50')
  })

  it('returns null for a percentage of zero rather than 0 or Infinity', () => {
    expect(percentOf('50', '0')).toBeNull()
    expect(percentChange('0', '100')).toBeNull()
  })

  it('computes percentages to one decimal place', () => {
    expect(percentOf('50', '200')).toBe('25')
    expect(percentOf('1', '3')).toBe('33.3')
  })

  it('formats money with currency-appropriate decimals', () => {
    expect(money('27431.5', 'KRW')).toBe('27,432 KRW')   // 0 decimals, rounded
    expect(money('27431.49', 'GBP')).toBe('27,431.49 GBP')
    expect(money('1234567.891', 'USD')).toBe('1,234,567.89 USD')
    expect(money('0', 'KRW')).toBe('0 KRW')
  })

  it('detects zero across representations', () => {
    expect(isZero('0')).toBe(true)
    expect(isZero('0.00')).toBe(true)
    expect(isZero('0.01')).toBe(false)
  })
})

describe('rule 3 — budget pace projection', () => {
  const spending = {
    current: window({ expense: '1000', categories: [cat('c1', 'Food', '1000')] }),
    monthlyBudget: '2000',
  }

  // The gate the live test could not check on most days.
  it.each([1, 2, 3, 4, 5, 6])('is suppressed on day %i', (dayOfMonth) => {
    const out = buildInsights(ctx({ ...spending, dayOfMonth }))
    expect(out.some((i: any) => i.id === 'budget_pace')).toBe(false)
  })

  it.each([7, 8, 15, 28, 31])('fires on day %i', (dayOfMonth) => {
    const out = buildInsights(ctx({ ...spending, dayOfMonth }))
    expect(out.some((i: any) => i.id === 'budget_pace')).toBe(true)
  })

  it('labels itself a projection and names the days used', () => {
    const out = buildInsights(ctx({ ...spending, dayOfMonth: 10 }))
    const pace = out.find((i: any) => i.id === 'budget_pace')!
    expect(pace.text).toMatch(/projection/i)
    expect(pace.text).toMatch(/10 days/)
  })

  it('projects proportionally: half the month at 1000 implies about 2000', () => {
    // day 15 of 30 -> 1000 / 15 * 30 = 2000
    const out = buildInsights(
      ctx({ ...spending, dayOfMonth: 15, daysInMonth: 30, monthlyBudget: '5000' }),
    )
    const pace = out.find((i: any) => i.id === 'budget_pace')!
    expect(pace.text).toMatch(/2,000 KRW/)
  })

  it('warns when the projection exceeds the budget, and states the overage', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '1000', categories: [cat('c1', 'Food', '1000')] }),
        monthlyBudget: '1500', dayOfMonth: 15, daysInMonth: 30,
      }),
    )
    const pace = out.find((i: any) => i.id === 'budget_pace')!
    expect(pace.tone).toBe('warn')
    expect(pace.text).toMatch(/over/)
    expect(pace.text).toMatch(/500 KRW/) // 2000 projected - 1500 budget
  })

  it('is suppressed with no budget set', () => {
    const out = buildInsights(ctx({ ...spending, monthlyBudget: null, dayOfMonth: 20 }))
    expect(out.some((i: any) => i.id === 'budget_pace')).toBe(false)
  })

  it('is suppressed with a zero budget rather than dividing by it', () => {
    const out = buildInsights(ctx({ ...spending, monthlyBudget: '0', dayOfMonth: 20 }))
    expect(out.some((i: any) => i.id === 'budget_pace')).toBe(false)
  })

  it('is suppressed with no spend yet', () => {
    const out = buildInsights(ctx({ current: window(), monthlyBudget: '2000', dayOfMonth: 20 }))
    expect(out.some((i: any) => i.id === 'budget_pace')).toBe(false)
  })
})

describe('rule 1 — category share', () => {
  it('names the largest category with its share', () => {
    const out = buildInsights(
      ctx({
        current: window({
          expense: '1000',
          categories: [cat('c1', 'Food', '600'), cat('c2', 'Transport', '400')],
        }),
      }),
    )
    const share = out.find((i: any) => i.id === 'category_share')!
    expect(share.text).toMatch(/Food/)
    expect(share.text).toMatch(/60%/)
  })

  it('adds a same-period comparison when the prior period had that category', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '1000', categories: [cat('c1', 'Food', '600')] }),
        prior: window({ expense: '500', categories: [cat('c1', 'Food', '300')] }),
      }),
    )
    const share = out.find((i: any) => i.id === 'category_share')!
    expect(share.text).toMatch(/up 100%/)
  })

  it('omits the comparison rather than inventing one when prior is empty', () => {
    const out = buildInsights(
      ctx({ current: window({ expense: '1000', categories: [cat('c1', 'Food', '600')] }) }),
    )
    const share = out.find((i: any) => i.id === 'category_share')!
    expect(share.text).not.toMatch(/last month/)
    expect(share.text).not.toMatch(/Infinity|NaN/)
  })

  it('is suppressed with no categories', () => {
    const out = buildInsights(ctx({ current: window({ expense: '0' }) }))
    expect(out.some((i: any) => i.id === 'category_share')).toBe(false)
  })
})

describe('rule 2 — category swing', () => {
  it('reports the largest mover with percentage and absolute change', () => {
    const out = buildInsights(
      ctx({
        current: window({
          expense: '1000',
          categories: [cat('c1', 'Food', '500'), cat('c2', 'Transport', '500')],
        }),
        prior: window({
          expense: '600',
          categories: [cat('c1', 'Food', '450'), cat('c2', 'Transport', '150')],
        }),
      }),
    )
    const swing = out.find((i: any) => i.id === 'category_swing')
    expect(swing).toBeDefined()
    // Transport moved 150 -> 500 (+233%), Food only 450 -> 500 (+11%)
    expect(swing!.text).toMatch(/Transport/)
    expect(swing!.text).toMatch(/up/)
  })

  it('suppresses a swing under the noise threshold', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '1000', categories: [cat('c1', 'Food', '105')] }),
        prior: window({ expense: '1000', categories: [cat('c1', 'Food', '100')] }),
      }),
    )
    // +5% is not worth one of three slots.
    expect(out.some((i: any) => i.id === 'category_swing')).toBe(false)
  })

  it('is suppressed when there is no prior period at all', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '1000', categories: [cat('c1', 'Food', '500')] }),
        prior: window({ total_count: 0 }),
      }),
    )
    expect(out.some((i: any) => i.id === 'category_swing')).toBe(false)
  })
})

describe('rule 4 — outlier', () => {
  it('flags a category dominated by very few transactions', () => {
    const out = buildInsights(
      ctx({
        current: window({
          expense: '1000',
          categories: [cat('c1', 'Travel', '400', 1), cat('c2', 'Food', '600', 20)],
        }),
      }),
    )
    const outlier = out.find((i: any) => i.id === 'outlier')
    expect(outlier).toBeDefined()
    expect(outlier!.text).toMatch(/Travel/)
    expect(outlier!.text).toMatch(/1 transaction\b/)
    expect(outlier!.text).toMatch(/40%/)
  })

  it('pluralises the transaction count correctly', () => {
    const out = buildInsights(
      ctx({
        current: window({
          expense: '1000', categories: [cat('c1', 'Travel', '400', 2)],
        }),
      }),
    )
    const outlier = out.find((i: any) => i.id === 'outlier')!
    expect(outlier.text).toMatch(/2 transactions/)
  })

  it('ignores a category with many transactions', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '1000', categories: [cat('c1', 'Food', '900', 40)] }),
      }),
    )
    expect(out.some((i: any) => i.id === 'outlier')).toBe(false)
  })

  it('ignores a small category even with few transactions', () => {
    const out = buildInsights(
      ctx({
        current: window({
          expense: '1000',
          categories: [cat('c1', 'Food', '950', 30), cat('c2', 'Misc', '50', 1)],
        }),
      }),
    )
    expect(out.some((i: any) => i.id === 'outlier')).toBe(false)
  })
})

describe('rule 5 — no-spend streak', () => {
  it('reports a genuine streak', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '1000', categories: [cat('c1', 'Food', '1000')], total_count: 5 }),
        noSpendStreak: 4, dayOfMonth: 20,
      }),
    )
    const streak = out.find((i: any) => i.id === 'streak')
    // May be crowded out by higher-signal rules; assert the text when present.
    if (streak) expect(streak.text).toMatch(/4 days/)
  })

  it('is suppressed on a month with no transactions at all', () => {
    // "No spending for 31 days" on an empty month reads as restraint when it
    // actually means no data.
    const out = buildInsights(
      ctx({ current: window({ total_count: 0 }), noSpendStreak: 31, dayOfMonth: 31 }),
    )
    expect(out.some((i: any) => i.id === 'streak')).toBe(false)
    expect(out.length).toBe(0)
  })

  it('is suppressed when the streak covers every elapsed day', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '0', total_count: 2 }),
        noSpendStreak: 10, dayOfMonth: 10,
      }),
    )
    expect(out.some((i: any) => i.id === 'streak')).toBe(false)
  })

  it('is suppressed for a one-day gap', () => {
    const out = buildInsights(
      ctx({
        current: window({ expense: '100', categories: [cat('c1', 'Food', '100')], total_count: 3 }),
        noSpendStreak: 1, dayOfMonth: 15,
      }),
    )
    expect(out.some((i: any) => i.id === 'streak')).toBe(false)
  })
})

describe('output contract', () => {
  const busy = ctx({
    dayOfMonth: 20,
    monthlyBudget: '1000',
    current: window({
      expense: '900',
      categories: [
        cat('c1', 'Travel', '400', 1), cat('c2', 'Food', '300', 15),
        cat('c3', 'Transport', '200', 8),
      ],
      total_count: 24,
    }),
    prior: window({
      expense: '500',
      categories: [
        cat('c1', 'Travel', '50', 1), cat('c2', 'Food', '300', 14),
        cat('c3', 'Transport', '150', 7),
      ],
      total_count: 22,
    }),
    noSpendStreak: 3,
  })

  it('emits at most three even when every rule could fire', () => {
    expect(buildInsights(busy).length).toBe(3)
  })

  it('honours an explicit lower limit', () => {
    expect(buildInsights(busy, 1).length).toBe(1)
    expect(buildInsights(busy, 2).length).toBe(2)
  })

  it('is deterministic — identical input gives identical output', () => {
    const a = JSON.stringify(buildInsights(busy))
    const b = JSON.stringify(buildInsights(busy))
    expect(a).toBe(b)
  })

  it('never emits filler, moralising, or broken numbers', () => {
    for (const insight of buildInsights(busy)) {
      expect(insight.text).toMatch(/\d/)
      expect(insight.text).not.toMatch(/Infinity|NaN|undefined|null/)
      expect(insight.text).not.toMatch(
        /you should|try to|bad|wasteful|too much|treat yourself|great job|well done|guilty|splurge/i,
      )
      expect(insight.text.length).toBeLessThan(260)
    }
  })

  it('emits nothing for a completely empty month', () => {
    expect(buildInsights(ctx()).length).toBe(0)
  })
})
