import { useState } from 'react'
import { profileApi } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { COMMON_COUNTRIES, COMMON_CURRENCIES } from '../lib/seedData'
import { validateAmount } from '../lib/money'

export function OnboardingPage() {
  const { user, refreshProfile } = useAuth()
  const [studyCountry, setStudyCountry] = useState('')
  const [localCurrency, setLocalCurrency] = useState('')
  const [homeCurrency, setHomeCurrency] = useState('')
  const [monthlyBudget, setMonthlyBudget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return

    // Monthly budget is optional — blank stays null rather than becoming 0, so
    // "no budget set" and "a budget of zero" remain distinguishable.
    //
    // The budget is denominated in the LOCAL spending currency: that is what a
    // student thinks in when setting it. Kept as a decimal string and validated
    // against that currency's rules, never through parseFloat.
    let budget: string | null = null
    if (monthlyBudget.trim() !== '') {
      const problem = validateAmount(monthlyBudget, localCurrency)
      if (problem) {
        setError(problem)
        return
      }
      budget = monthlyBudget.trim()
    }

    setBusy(true)
    setError(null)

    let updateError: { message: string } | null = null
    try {
      await profileApi.update({
        study_country: studyCountry,
        local_currency: localCurrency,
        home_currency: homeCurrency,
        display_currency: homeCurrency,
        monthly_budget: budget,
        // Snapshot the basis so changing local currency later cannot silently
        // re-denominate an existing budget.
        budget_currency: budget === null ? null : localCurrency,
        onboarded: true,
      })
    } catch (e: unknown) {
      updateError = { message: e instanceof Error ? e.message : 'Could not save your setup.' }
    }

    setBusy(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    // Flipping `onboarded` re-renders the router straight onto Add.
    await refreshProfile()
  }

  const inputClass =
    'h-12 md:h-10 w-full rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-2 focus:border-accent'
  const labelClass = 'mb-1 block text-sm font-medium text-ink-2'

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-8">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-md border border-line p-6"
      >
        <h1 className="mb-1 text-lg font-semibold">Set up your budget</h1>
        <p className="mb-5 text-sm text-ink-2">
          Four quick questions. You can change these later.
        </p>

        <div className="mb-4">
          <label htmlFor="country" className={labelClass}>
            Study country
          </label>
          <select
            id="country"
            required
            value={studyCountry}
            onChange={(e) => setStudyCountry(e.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              Select country
            </option>
            {COMMON_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <label htmlFor="local-currency" className={labelClass}>
            Local currency
          </label>
          <select
            id="local-currency"
            required
            value={localCurrency}
            onChange={(e) => setLocalCurrency(e.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              Select currency
            </option>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-3">
            What you spend day to day. New entries default to this.
          </p>
        </div>

        <div className="mb-4">
          <label htmlFor="home-currency" className={labelClass}>
            Home currency
          </label>
          <select
            id="home-currency"
            required
            value={homeCurrency}
            onChange={(e) => setHomeCurrency(e.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              Select currency
            </option>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-5">
          <label htmlFor="budget" className={labelClass}>
            Monthly budget{' '}
            {localCurrency ? (
              <span className="text-ink-2">({localCurrency})</span>
            ) : null}{' '}
            <span className="text-ink-3">(optional)</span>
          </label>
          {/* An unlabelled money input is a bug regardless of what sits behind
              it: the currency is shown both as a prefix and in the label. */}
          <div className="flex items-stretch">
            <span
              className="flex items-center rounded-l-sm border border-r-0 border-line bg-surface-2 px-2 text-sm text-ink-2"
              aria-hidden
            >
              {localCurrency || '—'}
            </span>
            <input
              id="budget"
              type="text"
              inputMode="decimal"
              value={monthlyBudget}
              onChange={(e) =>
                setMonthlyBudget(e.target.value.replace(/[^0-9.]/g, ''))
              }
              className={`${inputClass} rounded-l-none`}
              placeholder={
                localCurrency
                  ? `What you plan to spend per month in ${localCurrency}`
                  : 'Pick your local currency first'
              }
              aria-describedby="budget-hint"
            />
          </div>
          <p id="budget-hint" className="mt-1 text-xs text-ink-3">
            {localCurrency && homeCurrency && localCurrency !== homeCurrency
              ? `Set this in ${localCurrency}, the currency you spend in. It is converted to ${homeCurrency} for comparisons.`
              : 'Set this in the currency you spend in day to day.'}
          </p>
          {monthlyBudget.trim() !== '' && validateAmount(monthlyBudget, localCurrency) && (
            <p className="mt-1 text-xs text-expense">
              {validateAmount(monthlyBudget, localCurrency)}
            </p>
          )}
        </div>

        {error && <p className="mb-3 text-sm text-expense">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="h-12 w-full rounded-md bg-accent text-sm font-semibold text-ink-inv hover:bg-accent-hover active:scale-[0.98] disabled:bg-surface-3 disabled:text-ink-3 md:h-10"
        >
          {busy ? 'Saving…' : 'Start tracking'}
        </button>
      </form>
    </div>
  )
}
