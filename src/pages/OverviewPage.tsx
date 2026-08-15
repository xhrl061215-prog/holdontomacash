import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { useAuth } from '../context/AuthContext'
import { overviewApi } from '../lib/supabaseClient'
import type { Overview } from '../lib/supabaseClient'
import { formatMoney } from '../lib/money'

/**
 * Donut palette from the Designer spec: 6 slices + Other.
 * The long tail groups into "Other" beyond 6 — matching Designer's existing cap
 * rather than introducing a second, contradictory rule.
 */
const SLICE_COLOURS = [
  'var(--color-chart-1)', 'var(--color-chart-2)', 'var(--color-chart-3)',
  'var(--color-chart-4)', 'var(--color-chart-5)', 'var(--color-chart-6)',
]
const OTHER_COLOUR = 'var(--color-chart-other)'
const MAX_SLICES = 6

function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** "2026-07" -> "July", for readable comparison labels. */
function monthName(monthStr: string) {
  const [y, m] = monthStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long', timeZone: 'UTC',
  })
}

export function OverviewPage() {
  const { profile, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  const [month, setMonth] = useState(currentMonth())
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await overviewApi.get(month))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => { load() }, [load])

  const homeCurrency = data?.home_currency ?? profile?.home_currency ?? ''

  /** Top 6 categories plus a grouped "Other" slice. */
  const slices = useMemo(() => {
    const cats = data?.categories ?? []
    if (cats.length <= MAX_SLICES) {
      return cats.map((c, i) => ({
        ...c, value: Number(c.total), colour: SLICE_COLOURS[i], grouped: false,
      }))
    }
    const head = cats.slice(0, MAX_SLICES)
    const tail = cats.slice(MAX_SLICES)
    const tailTotal = tail.reduce((sum, c) => sum + Number(c.total), 0)
    return [
      ...head.map((c, i) => ({
        ...c, value: Number(c.total), colour: SLICE_COLOURS[i], grouped: false,
      })),
      {
        category_id: null,
        // Name the count so a grouped slice is never mistaken for one category.
        category_name: `Other (${tail.length})`,
        total: String(tailTotal),
        tx_count: tail.reduce((n, c) => n + c.tx_count, 0),
        value: tailTotal,
        colour: OTHER_COLOUR,
        grouped: true,
      },
    ]
  }, [data])

  function openCategory(categoryId: string | null) {
    // Donut click lands on Transactions with that category filtered.
    if (!categoryId) return
    navigate(`/transactions?month=${month}&type=expense&category_id=${categoryId}`)
  }

  const card = 'rounded-sm border border-line bg-surface p-4'

  if (authLoading || (loading && !data)) {
    return <p className="py-16 text-center text-sm text-ink-3">Loading overview…</p>
  }

  if (error) {
    return (
      <div>
        <h1 className="mb-4 text-lg font-semibold">Overview</h1>
        <p className="rounded-sm bg-expense-soft px-3 py-2 text-sm text-expense">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const { totals, comparison, insights } = data
  const hasBudget = totals.monthly_budget !== null
  const noTransactions = data.transaction_count === 0

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">Overview</h1>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <span className="sr-only">Month</span>
          <input
            type="month"
            aria-label="Overview month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
            className="h-8 rounded-sm border border-line bg-surface px-2 text-sm outline-none focus:border-accent"
          />
        </label>
      </div>

      {/* Empty state: prompt to add, never an empty chart. */}
      {noTransactions ? (
        <div className="py-16 text-center">
          <p className="text-base font-medium text-ink-2">
            Nothing recorded for {monthName(month)}
          </p>
          <p className="mt-1 text-sm text-ink-3">
            Add a transaction and your totals will appear here.
          </p>
          <button
            onClick={() => navigate('/add')}
            className="mt-4 h-10 rounded-md bg-accent px-4 text-sm font-semibold text-ink-inv hover:bg-accent-hover"
          >
            Add a transaction
          </button>
        </div>
      ) : (
        <>
          {/* Pending rows are excluded from every total, and said so plainly. */}
          {data.pending_count > 0 && (
            <p className="mb-3 rounded-sm bg-surface-2 px-3 py-2 text-sm text-ink-2">
              {data.pending_count} transaction{data.pending_count === 1 ? '' : 's'} pending
              an exchange rate {data.pending_count === 1 ? 'is' : 'are'} not included in
              these totals.
            </p>
          )}
          {data.approximate_count > 0 && (
            <p className="mb-3 text-xs text-ink-3">
              {data.approximate_count} transaction
              {data.approximate_count === 1 ? '' : 's'} used an approximate rate, so
              these totals are approximate.
            </p>
          )}

          {/* Four numbers */}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className={card}>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Spent</p>
              <p className="mt-1 text-xl font-semibold text-expense">
                {formatMoney(totals.expense, homeCurrency)}
              </p>
              <p className="text-xs text-ink-3">{homeCurrency}</p>
            </div>
            <div className={card}>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Income</p>
              <p className="mt-1 text-xl font-semibold text-income">
                {formatMoney(totals.income, homeCurrency)}
              </p>
              <p className="text-xs text-ink-3">{homeCurrency}</p>
            </div>
            <div className={card}>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Net</p>
              <p
                className={`mt-1 text-xl font-semibold ${
                  totals.net.startsWith('-') ? 'text-expense' : 'text-income'
                }`}
              >
                {formatMoney(totals.net, homeCurrency)}
              </p>
              <p className="text-xs text-ink-3">{homeCurrency}</p>
            </div>
            <div className={card}>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
                Budget left
              </p>
              {hasBudget ? (
                <>
                  <p
                    className={`mt-1 text-xl font-semibold ${
                      totals.budget_remaining?.startsWith('-') ? 'text-expense' : ''
                    }`}
                  >
                    {formatMoney(totals.budget_remaining, homeCurrency)}
                  </p>
                  <p className="text-xs text-ink-3">
                    of {formatMoney(totals.monthly_budget, homeCurrency)} {homeCurrency}
                  </p>
                  {/* Show the budget as the user set it, so the number they
                      typed is always recognisable on screen. */}
                  {totals.budget_converted && totals.budget_original && (
                    <p className="mt-0.5 text-xs text-ink-3">
                      budget set as {formatMoney(totals.budget_original, totals.budget_currency ?? '')}{' '}
                      {totals.budget_currency}
                    </p>
                  )}
                </>
              ) : totals.budget_basis_unknown ? (
                <p className="mt-2 text-sm text-ink-3">
                  Budget can't be compared — no exchange rate available for{' '}
                  {totals.budget_currency ?? 'its currency'} right now.
                </p>
              ) : (
                // Never a misleading zero when no budget exists.
                <p className="mt-2 text-sm text-ink-3">
                  No budget set.{' '}
                  <span className="text-ink-2">Set one during onboarding.</span>
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Donut: 6 slices + Other, click through to filtered Transactions */}
            <div className={card}>
              <h2 className="mb-2 text-sm font-medium text-ink-2">Spending by category</h2>
              {slices.length === 0 ? (
                <p className="py-10 text-center text-sm text-ink-3">
                  No spending recorded for {monthName(month)}.
                </p>
              ) : (
                <>
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={slices}
                          dataKey="value"
                          nameKey="category_name"
                          innerRadius="60%"
                          outerRadius="90%"
                          stroke="var(--color-surface)"
                          strokeWidth={2}
                          isAnimationActive={false}
                          onClick={(entry: any) => openCategory(entry?.category_id)}
                        >
                          {slices.map((s) => (
                            <Cell
                              key={s.category_name}
                              fill={s.colour}
                              cursor={s.category_id ? 'pointer' : 'default'}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(v: any, name: any) => [
                            `${formatMoney(String(v), homeCurrency)} ${homeCurrency}`,
                            name,
                          ]}
                          contentStyle={{
                            border: '1px solid var(--color-line)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '13px',
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {slices.map((s) => (
                      <li key={s.category_name}>
                        <button
                          onClick={() => openCategory(s.category_id)}
                          disabled={!s.category_id}
                          className={`flex w-full items-center justify-between text-sm ${
                            s.category_id ? 'hover:text-accent' : 'cursor-default'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 rounded-sm"
                              style={{ background: s.colour }}
                            />
                            {s.category_name}
                          </span>
                          <span className="font-medium">
                            {formatMoney(s.total, homeCurrency)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="space-y-4">
              {/* Equal-period comparison, labelled so it cannot be misread */}
              <div className={card}>
                <h2 className="mb-1 text-sm font-medium text-ink-2">
                  vs {monthName(comparison.prior_month)}
                </h2>
                <p className="mb-3 text-xs text-ink-3">
                  Comparing 1–{comparison.through_day} {monthName(month)} with 1–
                  {comparison.prior_through_day} {monthName(comparison.prior_month)}
                  {comparison.clamped && (
                    <>
                      {' '}
                      — {monthName(comparison.prior_month)} is shorter, so the range stops
                      at day {comparison.prior_through_day}.
                    </>
                  )}
                </p>

                {!comparison.comparable ? (
                  // Never ∞ or a bogus 100%.
                  <p className="text-sm text-ink-3">
                    No comparison available — nothing was recorded in the same period of{' '}
                    {monthName(comparison.prior_month)}.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {[
                      { label: monthName(month), value: comparison.current_expense, accent: true },
                      {
                        label: monthName(comparison.prior_month),
                        value: comparison.prior_expense, accent: false,
                      },
                    ].map((bar) => {
                      const max = Math.max(
                        Number(comparison.current_expense),
                        Number(comparison.prior_expense),
                        1,
                      )
                      const pct = (Number(bar.value) / max) * 100
                      return (
                        <div key={bar.label}>
                          <div className="mb-0.5 flex justify-between text-xs">
                            <span className="text-ink-2">{bar.label}</span>
                            <span className="font-medium">
                              {formatMoney(bar.value, homeCurrency)}
                            </span>
                          </div>
                          <div className="h-2 rounded-sm bg-surface-3">
                            <div
                              className={`h-2 rounded-sm ${
                                bar.accent ? 'bg-accent' : 'bg-ink-3'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      )
                    })}
                    {comparison.change_absolute && (
                      <p className="pt-1 text-sm">
                        <span
                          className={
                            comparison.change_absolute.startsWith('-')
                              ? 'text-income'
                              : 'text-expense'
                          }
                        >
                          {comparison.change_absolute.startsWith('-') ? '' : '+'}
                          {formatMoney(comparison.change_absolute, homeCurrency)}{' '}
                          {homeCurrency}
                        </span>{' '}
                        <span className="text-ink-3">vs the same period</span>
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Budget Consultant — plain text list, at most three */}
              <div className={card}>
                <h2 className="mb-2 text-sm font-medium text-ink-2">Budget Consultant</h2>
                {insights.length === 0 ? (
                  <p className="text-sm text-ink-3">
                    Not enough activity yet for useful observations.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {insights.map((i) => (
                      <li key={i.id} className="flex gap-2 text-sm">
                        <span
                          aria-hidden
                          className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                            i.tone === 'warn'
                              ? 'bg-expense'
                              : i.tone === 'ok'
                                ? 'bg-income'
                                : 'bg-ink-3'
                          }`}
                        />
                        <span className="text-ink">{i.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
