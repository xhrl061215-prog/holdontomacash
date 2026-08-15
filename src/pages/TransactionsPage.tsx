import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, transactionsApi } from '../lib/supabaseClient'
import type { TransactionFilters } from '../lib/supabaseClient'
import { formatMoney, formatRate, formatSigned } from '../lib/money'
import { COMMON_CURRENCIES } from '../lib/seedData'
import type { Category, PaymentMethod } from '../types'

interface Row {
  id: string
  transaction_type: 'expense' | 'income'
  amount: string | number
  currency: string
  transaction_date: string
  title: string
  description: string | null
  category_id: string | null
  payment_method_id: string | null
  category_name: string | null
  payment_method_name: string | null
  exchange_rate: string | number | null
  converted_amount: string | number | null
  converted_currency: string | null
  rate_date: string | null
  rate_source: string | null
  rate_is_approximate: boolean
}

const EMPTY: TransactionFilters = {
  month: '', category_id: '', payment_method_id: '',
  currency: '', type: '', q: '', sort: 'date_desc',
}

export function TransactionsPage() {
  const { profile, loading: authLoading } = useAuth()
  const homeCurrency = profile?.home_currency ?? ''

  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [categories, setCategories] = useState<Category[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [months, setMonths] = useState<string[]>([])
  const [currencies, setCurrencies] = useState<string[]>([])

  // Honour filters arriving in the URL, so a donut click on Overview lands here
  // with that category already applied.
  const [searchParams, setSearchParams] = useSearchParams()
  const [filters, setFilters] = useState<TransactionFilters>(() => ({
    ...EMPTY,
    month: searchParams.get('month') ?? '',
    category_id: searchParams.get('category_id') ?? '',
    payment_method_id: searchParams.get('payment_method_id') ?? '',
    currency: searchParams.get('currency') ?? '',
    type: (searchParams.get('type') as TransactionFilters['type']) ?? '',
    q: searchParams.get('q') ?? '',
  }))
  // Debounced copy of the search box so typing doesn't fire a request per key.
  const [searchInput, setSearchInput] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<Row>>({})
  const [savingEdit, setSavingEdit] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Display-currency switcher: view converted values in home currency, or see
  // only originals. Purely a view concern — never mutates stored data.
  const [showHomeValue, setShowHomeValue] = useState(true)

  const backfillAttempted = useRef(false)

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: searchInput })), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    Promise.all([
      supabase.from('categories').select().order(),
      supabase.from('payment_methods').select().order(),
    ]).then(([c, p]: any[]) => {
      if (c.data) setCategories(c.data)
      if (p.data) setPaymentMethods(p.data)
    })
  }, [])

  const loadOptions = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([
        transactionsApi.usedMonths(),
        transactionsApi.usedCurrencies(),
      ])
      setMonths(m.months ?? [])
      setCurrencies(c.currencies ?? [])
    } catch {
      // Filter options are a convenience; the table still works without them.
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await transactionsApi.list(filters)
      setRows(res.transactions as Row[])
      setTotal(res.total ?? res.transactions.length)

      // Backfill decision: on read, once per mount. Any row still lacking a
      // converted amount gets one retry, then the list refreshes if it helped.
      const pending = res.transactions.some((t: Row) => t.converted_amount === null)
      if (pending && !backfillAttempted.current) {
        backfillAttempted.current = true
        const out = await transactionsApi.backfill()
        if (out.filled > 0) {
          const again = await transactionsApi.list(filters)
          setRows(again.transactions as Row[])
          setTotal(again.total ?? again.transactions.length)
        }
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadOptions() }, [loadOptions])

  const activeFilterCount = useMemo(
    () =>
      (['month', 'category_id', 'payment_method_id', 'currency', 'type', 'q'] as const)
        .filter((k) => filters[k]).length,
    [filters],
  )

  function resetFilters() {
    setSearchInput('')
    setFilters({ ...EMPTY, sort: filters.sort })
    // Clear the URL too, or a reset would be undone by a reload.
    setSearchParams({}, { replace: true })
  }

  function toggleSort() {
    setFilters((f) => ({
      ...f,
      sort: f.sort === 'date_desc' ? 'date_asc' : 'date_desc',
    }))
  }

  function beginEdit(row: Row) {
    setEditingId(row.id)
    setDraft({
      amount: row.amount, currency: row.currency,
      transaction_date: row.transaction_date, title: row.title,
      description: row.description ?? '', category_id: row.category_id ?? '',
      payment_method_id: row.payment_method_id ?? '',
    })
  }

  async function saveEdit(id: string) {
    setSavingEdit(true)
    setError(null)
    try {
      await transactionsApi.update(id, {
        amount: Number(draft.amount),
        currency: draft.currency,
        transaction_date: draft.transaction_date,
        title: String(draft.title ?? '').trim(),
        description: String(draft.description ?? '').trim() || null,
        category_id: draft.category_id || null,
        payment_method_id: draft.payment_method_id || null,
      })
      setEditingId(null)
      await load()
      await loadOptions()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSavingEdit(false)
    }
  }

  async function remove(row: Row) {
    if (!confirm(`Delete "${row.title}"? This cannot be undone.`)) return
    setError(null)
    try {
      await transactionsApi.remove(row.id)
      await load()
      await loadOptions()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const selectClass =
    'h-8 rounded-sm border border-line bg-surface px-2 text-sm outline-none focus:border-accent'
  const editClass =
    'h-8 w-full rounded-sm border border-line bg-surface px-1.5 text-sm outline-none focus:border-accent'

  const categoriesFor = (row: Row) =>
    categories.filter((c) => c.type === row.transaction_type)

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">Transactions</h1>
        <span className="text-sm text-ink-3">
          {loading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Filters — inline, all combinable, single reset */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-3">
            ⌕
          </span>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search title or notes…"
            aria-label="Search transactions"
            className={`${selectClass} w-52 pl-6`}
          />
        </div>

        <select
          aria-label="Filter by month" value={filters.month}
          onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}
          className={selectClass}
        >
          <option value="">All months</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <select
          aria-label="Filter by type" value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as any }))}
          className={selectClass}
        >
          <option value="">Expense &amp; income</option>
          <option value="expense">Expense only</option>
          <option value="income">Income only</option>
        </select>

        <select
          aria-label="Filter by category" value={filters.category_id}
          onChange={(e) => setFilters((f) => ({ ...f, category_id: e.target.value }))}
          className={selectClass}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
          ))}
        </select>

        <select
          aria-label="Filter by payment method" value={filters.payment_method_id}
          onChange={(e) => setFilters((f) => ({ ...f, payment_method_id: e.target.value }))}
          className={selectClass}
        >
          <option value="">All methods</option>
          {paymentMethods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <select
          aria-label="Filter by currency" value={filters.currency}
          onChange={(e) => setFilters((f) => ({ ...f, currency: e.target.value }))}
          className={selectClass}
        >
          <option value="">All currencies</option>
          {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        {activeFilterCount > 0 && (
          <button
            onClick={resetFilters}
            className="text-sm font-medium text-accent hover:underline"
          >
            Reset filters ({activeFilterCount})
          </button>
        )}

        {/* Display-currency switcher */}
        {homeCurrency && (
          <label className="ml-auto flex items-center gap-1.5 text-sm text-ink-2">
            <input
              type="checkbox" checked={showHomeValue}
              onChange={(e) => setShowHomeValue(e.target.checked)}
              className="accent-accent"
            />
            Show {homeCurrency} value
          </label>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-sm bg-expense-soft px-3 py-2 text-sm text-expense">
          {error}
        </p>
      )}

      {/* Wait for the profile before drawing the table: the home-currency
          column is labelled from it, and rendering early flashes a placeholder
          header that then changes under the reader. */}
      {authLoading || (loading && rows.length === 0) ? (
        <p className="py-16 text-center text-sm text-ink-3">Loading transactions…</p>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-base font-medium text-ink-2">No transactions found</p>
          <p className="mt-1 text-sm text-ink-3">
            {activeFilterCount > 0
              ? 'No rows match these filters.'
              : 'Add your first transaction from the Add page.'}
          </p>
          {activeFilterCount > 0 && (
            <button
              onClick={resetFilters}
              className="mt-3 text-sm font-medium text-accent hover:underline"
            >
              Reset filters
            </button>
          )}
        </div>
      ) : (
        /* Real table semantics at every width — dense, zebra, never cards.
           Narrow screens scroll horizontally and can tap a row for details. */
        <div className="overflow-x-auto rounded-sm border border-line">
          <table className="table-dense w-full min-w-[820px]">
            <caption className="sr-only">
              Transactions with original and home-currency amounts
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <button
                    onClick={toggleSort}
                    className="font-medium uppercase tracking-[0.04em] text-ink-2 hover:text-accent"
                    aria-label={`Sort by date, currently ${
                      filters.sort === 'date_desc' ? 'newest first' : 'oldest first'
                    }`}
                  >
                    Date {filters.sort === 'date_desc' ? '↓' : '↑'}
                  </button>
                </th>
                <th scope="col">Title</th>
                <th scope="col">Category</th>
                <th scope="col">Details</th>
                <th scope="col">Payment Method</th>
                <th scope="col" className="col-amount">Original Amount</th>
                <th scope="col">Currency</th>
                <th scope="col" className="col-amount">Rate</th>
                {showHomeValue && (
                  <th scope="col" className="col-amount">
                    {homeCurrency || 'Home'} Value
                  </th>
                )}
                <th scope="col" className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                editingId === row.id ? (
                  <tr key={row.id}>
                    <td>
                      <input
                        type="date" value={String(draft.transaction_date ?? '')}
                        aria-label="Edit date" className={editClass}
                        onChange={(e) => setDraft((d) => ({ ...d, transaction_date: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="text" value={String(draft.title ?? '')}
                        aria-label="Edit title" className={editClass}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      />
                    </td>
                    <td>
                      <select
                        value={String(draft.category_id ?? '')} aria-label="Edit category"
                        className={editClass}
                        onChange={(e) => setDraft((d) => ({ ...d, category_id: e.target.value }))}
                      >
                        <option value="">—</option>
                        {categoriesFor(row).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text" value={String(draft.description ?? '')}
                        aria-label="Edit details" className={editClass}
                        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      />
                    </td>
                    <td>
                      <select
                        value={String(draft.payment_method_id ?? '')}
                        aria-label="Edit payment method" className={editClass}
                        onChange={(e) => setDraft((d) => ({ ...d, payment_method_id: e.target.value }))}
                      >
                        <option value="">—</option>
                        {paymentMethods.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="col-amount">
                      <input
                        type="text" inputMode="decimal" value={String(draft.amount ?? '')}
                        aria-label="Edit amount" className={`${editClass} text-right`}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, amount: e.target.value.replace(/[^0-9.]/g, '') }))
                        }
                      />
                    </td>
                    <td>
                      <select
                        value={String(draft.currency ?? '')} aria-label="Edit currency"
                        className={editClass}
                        onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
                      >
                        {COMMON_CURRENCIES.map((c) => (
                          <option key={c.code} value={c.code}>{c.code}</option>
                        ))}
                      </select>
                    </td>
                    <td className="col-amount text-ink-3" colSpan={showHomeValue ? 2 : 1}>
                      recalculates on save
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button
                        onClick={() => saveEdit(row.id)} disabled={savingEdit}
                        className="text-sm font-medium text-income hover:underline disabled:opacity-50"
                      >
                        {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="ml-2 text-sm text-ink-2 hover:text-ink"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={row.id}
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <td className="whitespace-nowrap">{row.transaction_date}</td>
                    <td className="max-w-[190px] truncate" title={row.title}>
                      {row.title}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className={row.transaction_type === 'income' ? 'text-income' : ''}>
                        {row.category_name ?? '—'}
                      </span>
                    </td>
                    <td
                      className={`max-w-[160px] text-ink-2 ${
                        expandedId === row.id ? 'whitespace-normal' : 'truncate'
                      }`}
                      title={row.description ?? ''}
                    >
                      {row.description || '—'}
                    </td>
                    <td className="whitespace-nowrap text-ink-2">
                      {row.payment_method_name ?? '—'}
                    </td>
                    {/* Original amount is always shown — never replaced by the
                        converted value. */}
                    <td
                      className={`col-amount ${
                        row.transaction_type === 'income' ? 'text-income' : ''
                      }`}
                    >
                      {formatSigned(row.amount, row.currency, row.transaction_type)}
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{row.currency}</td>
                    <td className="col-amount text-ink-2">
                      {row.converted_amount === null && row.exchange_rate === null ? (
                        <span className="text-ink-3" title="Exchange rate unavailable; will retry">
                          pending
                        </span>
                      ) : (
                        <span title={row.rate_date ? `Rate as of ${row.rate_date}` : undefined}>
                          {formatRate(row.exchange_rate)}
                        </span>
                      )}
                    </td>
                    {showHomeValue && (
                      <td className="col-amount">
                        {row.converted_amount === null ? (
                          <span className="text-ink-3">rate pending</span>
                        ) : (
                          <span
                            className={row.rate_is_approximate ? 'text-ink-2' : undefined}
                            title={
                              row.rate_is_approximate
                                ? `Approximate: a current rate was used because the rate for ${row.transaction_date} was unavailable`
                                : row.rate_date
                                  ? `Rate as of ${row.rate_date}`
                                  : undefined
                            }
                          >
                            {formatMoney(row.converted_amount, row.converted_currency ?? '')}
                            {row.rate_is_approximate && (
                              <span className="ml-0.5 text-ink-3" aria-label="approximate">≈</span>
                            )}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="text-right whitespace-nowrap">
                      <button
                        onClick={(e) => { e.stopPropagation(); beginEdit(row) }}
                        className="text-sm text-ink-2 hover:text-accent"
                        aria-label={`Edit ${row.title}`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); remove(row) }}
                        className="ml-2 text-sm text-ink-2 hover:text-expense"
                        aria-label={`Delete ${row.title}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {rows.some((r) => r.rate_is_approximate) && (
        <p className="mt-2 text-xs text-ink-3">
          ≈ marks a value converted at a current rate because the rate for that
          date was unavailable.
        </p>
      )}
    </div>
  )
}
