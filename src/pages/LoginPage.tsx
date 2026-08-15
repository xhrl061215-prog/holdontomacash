import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)

    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password })
      setBusy(false)
      if (error) {
        setError(error.message)
        return
      }
      // The profile row and the default categories / payment methods are
      // created server-side by the on_auth_user_created trigger, so there is
      // nothing to seed from here.
      if (!data.session) {
        setInfo('Check your email for a confirmation link to finish signing up.')
      }
      // With a session, the router moves straight to onboarding.
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      setBusy(false)
      if (error) setError(error.message)
    }
  }

  const inputClass =
    'h-12 md:h-10 w-full rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-2 focus:border-accent'

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Budget<span className="text-accent">Tracker</span>
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            Multi-currency budgeting for international students
          </p>
        </div>

        <div className="mb-4 flex overflow-hidden rounded-sm border border-line">
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m)
                setError(null)
                setInfo(null)
              }}
              className={`flex-1 py-2 text-sm ${
                mode === m
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-ink-2 hover:bg-surface-2'
              }`}
            >
              {m === 'signin' ? 'Sign in' : 'Sign up'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            placeholder="Password (min 6 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
          {error && <p className="text-sm text-expense">{error}</p>}
          {info && <p className="text-sm text-ink-2">{info}</p>}
          <button
            type="submit"
            disabled={busy}
            className="h-12 rounded-md bg-accent text-sm font-semibold text-ink-inv hover:bg-accent-hover active:scale-[0.98] disabled:bg-surface-3 disabled:text-ink-3 md:h-10"
          >
            {busy
              ? 'Please wait…'
              : mode === 'signup'
                ? 'Create account'
                : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
