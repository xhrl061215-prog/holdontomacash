/**
 * Regression: /overview rendered BLANK on the hosted backend.
 *
 * The SQL function `overview_for_month` and the preview API had drifted apart.
 * The function nests counts under `flags`, calls the current day
 * `current_through_day`, and omits `home_currency`, `transaction_count`,
 * `current_expense`, `change_absolute` and `insights` entirely. OverviewPage
 * destructures `insights` and calls `.length` on it, so the hosted build threw
 * "Cannot read properties of undefined (reading 'length')" during render and
 * React unmounted the whole tree.
 *
 * Captured from Lily's real Supabase project via the live RPC — the payload
 * below is the genuine response, not an invention.
 */
import { describe, expect, it } from 'vitest'
import { subtractDecimalStrings } from '../lib/money'

/** Verbatim response from `overview_for_month` on a real hosted project. */
const REAL_RPC_PAYLOAD = {
  flags: { pending_count: 0, approximate_count: 0 },
  month: '2026-08',
  totals: {
    net: '0',
    income: '0',
    expense: '0',
    monthly_budget: '1200.00',
    budget_currency: 'KRW',
    budget_original: '1200.00',
    budget_converted: false,
    budget_remaining: '1200.00',
    display_currency: 'KRW',
    budget_basis_unknown: false,
  },
  categories: [],
  comparison: {
    clamped: false,
    comparable: false,
    prior_month: '2026-07',
    prior_income: '0',
    prior_expense: '0',
    prior_through_day: 15,
    current_through_day: 15,
  },
}

/** Fields OverviewPage reads directly; a missing one blanks the page. */
const REQUIRED_TOP = [
  'month',
  'home_currency',
  'totals',
  'pending_count',
  'approximate_count',
  'transaction_count',
  'categories',
  'comparison',
  'insights',
] as const

const REQUIRED_COMPARISON = [
  'prior_month',
  'through_day',
  'prior_through_day',
  'clamped',
  'current_expense',
  'prior_expense',
  'change_absolute',
  'comparable',
] as const

import { adaptOverviewForTest } from '../lib/overviewShape'

describe('hosted overview payload satisfies the page contract', () => {
  it('the real RPC payload is missing the fields that broke the page', () => {
    // Documents WHY the adapter exists. If the SQL function is ever changed to
    // return these directly, this test failing is the signal to simplify.
    expect(REAL_RPC_PAYLOAD).not.toHaveProperty('insights')
    expect(REAL_RPC_PAYLOAD).not.toHaveProperty('transaction_count')
    expect(REAL_RPC_PAYLOAD).not.toHaveProperty('home_currency')
    expect(REAL_RPC_PAYLOAD.comparison).not.toHaveProperty('through_day')
    expect(REAL_RPC_PAYLOAD.comparison).not.toHaveProperty('current_expense')
  })

  it('adapting it produces every field the page destructures', () => {
    const out = adaptOverviewForTest(REAL_RPC_PAYLOAD, '2026-08', null)
    for (const key of REQUIRED_TOP) expect(out).toHaveProperty(key)
    for (const key of REQUIRED_COMPARISON) expect(out.comparison).toHaveProperty(key)
  })

  it('insights is always an array, because the page calls .length on it', () => {
    expect(Array.isArray(adaptOverviewForTest(REAL_RPC_PAYLOAD, '2026-08', null).insights)).toBe(true)
    // And with a garbage payload, rather than throwing.
    expect(Array.isArray(adaptOverviewForTest({}, '2026-08', null).insights)).toBe(true)
    expect(Array.isArray(adaptOverviewForTest(null, '2026-08', null).insights)).toBe(true)
  })

  it('a null-ish payload degrades to zeroes instead of crashing the render', () => {
    const out = adaptOverviewForTest(null, '2026-08', 'GBP')
    expect(out.totals.expense).toBe('0')
    expect(out.transaction_count).toBe(0)
    expect(out.categories).toEqual([])
    expect(out.home_currency).toBe('GBP')
  })

  it('maps display_currency onto home_currency', () => {
    expect(adaptOverviewForTest(REAL_RPC_PAYLOAD, '2026-08', null).home_currency).toBe('KRW')
  })

  it('reads the day from current_through_day, not the prior month', () => {
    const out = adaptOverviewForTest(
      { ...REAL_RPC_PAYLOAD, comparison: { ...REAL_RPC_PAYLOAD.comparison, current_through_day: 9, prior_through_day: 30 } },
      '2026-08',
      null,
    )
    expect(out.comparison.through_day).toBe(9)
    expect(out.comparison.prior_through_day).toBe(30)
  })

  it('counts PENDING rows in transaction_count, or the page denies they exist', () => {
    // Found on the live deployment: a saved transaction awaiting an exchange rate
    // is excluded from `categories` by design, so summing categories alone gave 0
    // and Overview rendered "Nothing recorded for August" over a real record.
    const out = adaptOverviewForTest(
      { ...REAL_RPC_PAYLOAD, categories: [], flags: { pending_count: 1, approximate_count: 0 } },
      '2026-08',
      null,
    )
    expect(out.transaction_count).toBe(1)
    expect(out.pending_count).toBe(1)
  })

  it('does not double-count approximate rows, which are already in categories', () => {
    const out = adaptOverviewForTest(
      {
        ...REAL_RPC_PAYLOAD,
        categories: [{ category_id: 'a', category_name: 'Groceries', total: '10', tx_count: 2 }],
        flags: { pending_count: 0, approximate_count: 2 },
      },
      '2026-08',
      null,
    )
    expect(out.transaction_count).toBe(2)
  })

  it('derives transaction_count by summing category counts', () => {
    const out = adaptOverviewForTest(
      {
        ...REAL_RPC_PAYLOAD,
        categories: [
          { category_id: 'a', category_name: 'Groceries', total: '12.50', tx_count: 3 },
          { category_id: 'b', category_name: 'Transport', total: '4.00', tx_count: 2 },
        ],
      },
      '2026-08',
      null,
    )
    expect(out.transaction_count).toBe(5)
  })

  it('change_absolute is null when not comparable, never 0', () => {
    // A 0 here would render as "no change" — a claim the data cannot support.
    expect(adaptOverviewForTest(REAL_RPC_PAYLOAD, '2026-08', null).comparison.change_absolute).toBeNull()
  })

  it('computes change_absolute with exact decimals when comparable', () => {
    const out = adaptOverviewForTest(
      {
        ...REAL_RPC_PAYLOAD,
        totals: { ...REAL_RPC_PAYLOAD.totals, expense: '0.30' },
        comparison: { ...REAL_RPC_PAYLOAD.comparison, comparable: true, prior_expense: '0.10' },
      },
      '2026-08',
      null,
    )
    // 0.30 - 0.10 in floats is 0.19999999999999998; exact decimals give 0.2.
    expect(out.comparison.change_absolute).toBe('0.2')
    expect(subtractDecimalStrings('0.30', '0.10')).toBe('0.2')
  })
})
