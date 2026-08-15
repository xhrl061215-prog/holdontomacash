import { useEffect, useState } from 'react'
import { categoriesApi, paymentMethodsApi, transactionsApi } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { todayStr } from '../lib/date'
import { COMMON_CURRENCIES } from '../lib/seedData'
import { validateAmount } from '../lib/money'
import type { Category, PaymentMethod, TransactionType } from '../types'

export function AddTransactionPage() {
  const { user, profile } = useAuth()

  // Form state
  const [type, setType] = useState<TransactionType>('expense')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('')
  const [date, setDate] = useState(todayStr())
  const [categoryId, setCategoryId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [paymentMethodId, setPaymentMethodId] = useState('')
  const [showDetails, setShowDetails] = useState(false)

  // Reference data
  const [categories, setCategories] = useState<Category[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])

  // Submit state
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Default currency = the user's local currency
  useEffect(() => {
    if (profile?.local_currency && !currency) {
      setCurrency(profile.local_currency)
    }
  }, [profile, currency])

  // Load this user's categories + payment methods (RLS scopes them to them)
  useEffect(() => {
    if (!user) return
    Promise.all([categoriesApi.list(), paymentMethodsApi.list()])
      .then(([catRes, pmRes]) => {
        setCategories((catRes.categories ?? []) as Category[])
        setPaymentMethods((pmRes.payment_methods ?? []) as PaymentMethod[])
      })
      .catch((e: unknown) => {
        // Surface it: a silent catch here is what made this page look blank.
        setError(e instanceof Error ? e.message : 'Could not load categories.')
      })
  }, [user])

  const filteredCategories = categories.filter((c) => c.type === type)

  // Keep the category selection valid when the expense/income toggle flips
  useEffect(() => {
    const stillValid = filteredCategories.some((c) => c.id === categoryId)
    if (!stillValid) {
      setCategoryId(filteredCategories[0]?.id ?? '')
    }
  }, [type, categories]) // eslint-disable-line react-hooks/exhaustive-deps

  // Default payment method
  useEffect(() => {
    if (paymentMethodId) return
    const def = paymentMethods.find((p) => p.is_default) ?? paymentMethods[0]
    if (def) setPaymentMethodId(def.id)
  }, [paymentMethods, paymentMethodId])

  function resetForm() {
    // Reset the entry fields; keep currency, date, category and payment method
    // so logging several same-day expenses in a row stays fast.
    setAmount('')
    setTitle('')
    setDescription('')
    setShowDetails(false)
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return

    // Same rules as the server, so the user is told here rather than after a
    // round trip. The amount is sent as a STRING — never through Number — so no
    // float error can enter the money path.
    const amountProblem = validateAmount(amount, currency)
    if (amountProblem) {
      setError(amountProblem)
      return
    }
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    if (!currency) {
      setError('Pick a currency.')
      return
    }

    setSaving(true)
    setError(null)

    let insertError: { message: string } | null = null
    try {
      await transactionsApi.create({
      user_id: user.id,
      transaction_type: type,
      amount: amount.trim(),
      currency,
      transaction_date: date,
      category_id: categoryId || null,
      title: title.trim(),
      description: description.trim() || null,
      payment_method_id: paymentMethodId || null,
      })
    } catch (e: unknown) {
      insertError = { message: e instanceof Error ? e.message : 'Could not save.' }
    }

    setSaving(false)
    if (insertError) {
      setError(insertError.message)
      return
    }

    resetForm()
    setSuccess(true)
    window.setTimeout(() => setSuccess(false), 2500)
  }

  const inputClass =
    'h-12 md:h-10 w-full rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-2 focus:border-accent'
  const labelClass = 'mb-1 block text-sm font-medium text-ink-2'

  return (
    <div className="max-w-md">
      <h1 className="mb-5 text-lg font-semibold">Add Transaction</h1>

      {/* Success state — small, transient; the user stays on this page */}
      <div aria-live="polite">
        {success && (
          <div className="mb-4 rounded-sm bg-income-soft px-3 py-2 text-sm font-medium text-income">
            Saved. Add another.
          </div>
        )}
      </div>

      {/* Expense / Income — segmented pill */}
      <div className="mb-5 flex h-11 rounded-full bg-surface-3 p-[3px] md:h-10">
        {(['expense', 'income'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`flex-1 rounded-full text-sm font-semibold capitalize ${
              type === t
                ? t === 'expense'
                  ? 'bg-expense-soft text-expense'
                  : 'bg-income-soft text-income'
                : 'text-ink-2'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Amount — the biggest, most immediate field */}
        <div>
          <label htmlFor="amount" className={labelClass}>
            Amount
          </label>
          <div className="flex items-baseline gap-2 border-b border-line pb-2">
            <span className="text-xl text-ink-3">{currency || '—'}</span>
            <input
              id="amount"
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) =>
                setAmount(e.target.value.replace(/[^0-9.]/g, ''))
              }
              className="w-full min-w-0 flex-1 border-none bg-transparent text-3xl font-bold outline-none"
              style={{ fontFamily: 'var(--font-mono)' }}
              autoFocus
            />
          </div>
          {/* Live feedback: catch a bad amount as it is typed rather than on
              submit, and never silently alter what was entered. */}
          {amount.trim() !== '' && validateAmount(amount, currency) && (
            <p className="mt-1 text-xs text-expense">
              {validateAmount(amount, currency)}
            </p>
          )}
        </div>

        {/* Currency — defaults to the user's local currency */}
        <div>
          <label htmlFor="currency" className={labelClass}>
            Currency
          </label>
          <select
            id="currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={inputClass}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Date — defaults to today */}
        <div>
          <label htmlFor="date" className={labelClass}>
            Date
          </label>
          <input
            id="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Category */}
        <div>
          <label htmlFor="category" className={labelClass}>
            Category
          </label>
          <select
            id="category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass}
          >
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Title */}
        <div>
          <label htmlFor="title" className={labelClass}>
            Title
          </label>
          <input
            id="title"
            type="text"
            required
            placeholder="What was it for?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Description — collapsed by default to keep the common path short */}
        {!showDetails ? (
          <button
            type="button"
            onClick={() => setShowDetails(true)}
            className="self-start text-sm font-medium text-accent hover:underline"
          >
            + Add description
          </button>
        ) : (
          <div>
            <label htmlFor="description" className={labelClass}>
              Description <span className="text-ink-3">(optional)</span>
            </label>
            <textarea
              id="description"
              rows={2}
              placeholder="Notes…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-sm border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-2 focus:border-accent"
            />
          </div>
        )}

        {/* Payment Method */}
        <div>
          <label htmlFor="payment-method" className={labelClass}>
            Payment Method
          </label>
          <select
            id="payment-method"
            value={paymentMethodId}
            onChange={(e) => setPaymentMethodId(e.target.value)}
            className={inputClass}
          >
            {paymentMethods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-sm text-expense">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="h-12 w-full rounded-md bg-accent text-sm font-semibold text-ink-inv transition-transform hover:bg-accent-hover active:scale-[0.98] disabled:bg-surface-3 disabled:text-ink-3 md:h-10"
        >
          {saving ? 'Saving…' : 'Save Transaction'}
        </button>
      </form>
    </div>
  )
}
