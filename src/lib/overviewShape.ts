/**
 * Adapts the hosted `overview_for_month` RPC payload to the `Overview` contract
 * the pages consume.
 *
 * Its own module so it can be tested without constructing a Supabase client,
 * and so the mapping lives in exactly one place.
 */
import type { Overview } from './supabaseClient'
import { subtractDecimalStrings } from './money'

/**
 * Reshape the SQL function's payload into the `Overview` contract the pages use.
 *
 * The RPC and the preview API had DRIFTED: the function nests the counts under
 * `flags`, names the current-month day `current_through_day`, and omits
 * `home_currency`, `transaction_count`, `current_expense`, `change_absolute` and
 * `insights` entirely. OverviewPage destructures `insights` and calls
 * `.length` on it, so on the hosted backend it threw and the page went blank.
 *
 * Adapting here — one place, at the boundary — rather than teaching the pages
 * about two shapes. This is the serialiser-not-schema rule from earlier in the
 * project: wrong at the API boundary means suspect the boundary.
 */
export function adaptOverview(raw: any, month: string, homeCurrency: string | null): Overview {
  const totals = raw?.totals ?? {}
  const cmp = raw?.comparison ?? {}
  const flags = raw?.flags ?? {}
  const categories = raw?.categories ?? []

  const currentExpense = String(totals.expense ?? '0')
  const priorExpense = String(cmp.prior_expense ?? '0')

  return {
    month: raw?.month ?? month,
    // The function reports it as display_currency; the pages call it home_currency.
    home_currency: totals.display_currency ?? homeCurrency ?? null,
    totals: {
      expense: currentExpense,
      income: String(totals.income ?? '0'),
      net: String(totals.net ?? '0'),
      budget_remaining: totals.budget_remaining ?? null,
      monthly_budget: totals.monthly_budget ?? null,
      budget_original: totals.budget_original ?? null,
      budget_currency: totals.budget_currency ?? null,
      budget_converted: Boolean(totals.budget_converted),
      budget_basis_unknown: Boolean(totals.budget_basis_unknown),
    },
    pending_count: Number(flags.pending_count ?? 0),
    approximate_count: Number(flags.approximate_count ?? 0),
    // Not returned by the function, so derive it — and PENDING rows must be
    // counted. They are deliberately excluded from `categories` and the totals
    // (no exchange rate yet), so summing categories alone reports 0 and the page
    // renders "Nothing recorded for August" while the user's transaction plainly
    // exists. Counting them makes the page show the pending notice instead,
    // which is the honest state. Approximate rows ARE in categories already, so
    // adding them here would double-count.
    transaction_count:
      categories.reduce((n: number, c: any) => n + Number(c.tx_count ?? 0), 0) +
      Number(flags.pending_count ?? 0),
    categories,
    comparison: {
      prior_month: cmp.prior_month ?? '',
      through_day: Number(cmp.current_through_day ?? 0),
      prior_through_day: Number(cmp.prior_through_day ?? 0),
      clamped: Boolean(cmp.clamped),
      current_expense: currentExpense,
      prior_expense: priorExpense,
      // null, never 0, when there is nothing to compare against.
      change_absolute: cmp.comparable
        ? subtractDecimalStrings(currentExpense, priorExpense)
        : null,
      comparable: Boolean(cmp.comparable),
    },
    // Never undefined: the page calls .length on this.
    insights: [],
  }
}


/** Test-only alias, so the regression suite does not depend on import order. */
export const adaptOverviewForTest = adaptOverview
