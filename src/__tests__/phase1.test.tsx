/**
 * Phase 1 behaviour tests. Supabase is mocked, so these assert OUR logic:
 * the auth gate, the onboarding gate, and the Add form's contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// ---- Supabase mock ----
const state = {
  session: null as any,
  profile: null as any,
  inserted: [] as any[],
  updated: [] as any[],
}

const categories = [
  { id: 'c1', user_id: 'u1', name: 'Food', type: 'expense', is_default: true, sort_order: 1 },
  { id: 'c2', user_id: 'u1', name: 'Transport', type: 'expense', is_default: true, sort_order: 2 },
  { id: 'c9', user_id: 'u1', name: 'Allowance', type: 'income', is_default: true, sort_order: 1 },
]
const paymentMethods = [
  { id: 'p1', user_id: 'u1', name: 'Cash', is_default: true, sort_order: 1 },
  { id: 'p2', user_id: 'u1', name: 'Debit Card', is_default: false, sort_order: 2 },
]

vi.mock('../lib/supabaseClient', () => {
  // Mocks the TYPED APIs, which is the only surface both backends share.
  // A previous version of this mock provided a working `.from()` shim, and that
  // is exactly why the blank-page bug was invisible here: the hosted backend's
  // `.from()` throws, so mocking a working one tested a shape production never
  // had. Mock what both backends implement, not what one of them happens to.
  return {
    categoriesApi: { list: () => Promise.resolve({ categories }) },
    paymentMethodsApi: { list: () => Promise.resolve({ payment_methods: paymentMethods }) },
    profileApi: {
      get: () => Promise.resolve({ profile: state.profile }),
      create: () => Promise.resolve({ profile: state.profile }),
      update: (changes: any) => {
        state.updated.push(changes)
        return Promise.resolve({ profile: { ...state.profile, ...changes } })
      },
    },
    transactionsApi: {
      create: (row: any) => {
        state.inserted.push(row)
        return Promise.resolve({ transaction: row })
      },
      list: () => Promise.resolve({ transactions: [], total: 0 }),
      usedMonths: () => Promise.resolve({ months: [] }),
      usedCurrencies: () => Promise.resolve({ currencies: [] }),
    },
    overviewApi: { get: () => Promise.resolve({}) },
    supabase: {
      from: () => {
        throw new Error('use the typed apis')
      },
      auth: {
        getSession: () => Promise.resolve({ data: { session: state.session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signUp: vi.fn(),
        signInWithPassword: vi.fn(),
        signOut: vi.fn(() => Promise.resolve()),
      },
    },
    // These tests exercise the preview backend, so the app must not render the
    // "not configured yet" notice instead of the real routes.
    backendMode: 'preview' as const,
  }
})

import App from '../App'
import { AuthProvider } from '../context/AuthContext'
import { AddTransactionPage } from '../pages/AddTransactionPage'

const USER = { id: 'u1', email: 'test@example.com' }
const ONBOARDED = {
  id: 'u1', study_country: 'KR', local_currency: 'KRW', home_currency: 'USD',
  display_currency: 'USD', monthly_budget: null, onboarded: true,
  created_at: '', updated_at: '',
}

beforeEach(() => {
  state.session = null
  state.profile = null
  state.inserted = []
  state.updated = []
})

describe('auth gate', () => {
  it('shows the sign-in screen when there is no session', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Email/i)).toBeDefined()
    })
    // Must not leak the authenticated app
    expect(screen.queryByText('Add Transaction')).toBeNull()
  })
})

describe('onboarding gate', () => {
  it('routes a signed-in but un-onboarded user to onboarding, not Add', async () => {
    state.session = { user: USER }
    state.profile = { ...ONBOARDED, onboarded: false, local_currency: null }
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('Set up your budget')).toBeDefined()
    })
    expect(screen.queryByText('Add Transaction')).toBeNull()
  })

  it('treats a missing local currency as un-onboarded even if the flag is true', async () => {
    state.session = { user: USER }
    state.profile = { ...ONBOARDED, onboarded: true, local_currency: null }
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('Set up your budget')).toBeDefined()
    })
  })

  it('lands a returning onboarded user directly on Add', async () => {
    state.session = { user: USER }
    state.profile = ONBOARDED
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('Add Transaction')).toBeDefined()
    })
  })

  it('stores a blank monthly budget as null, not 0', async () => {
    state.session = { user: USER }
    state.profile = { ...ONBOARDED, onboarded: false, local_currency: null }
    render(<App />)
    await waitFor(() => screen.getByText('Set up your budget'))

    fireEvent.change(screen.getByLabelText(/Study country/i), { target: { value: 'KR' } })
    fireEvent.change(screen.getByLabelText(/Local currency/i), { target: { value: 'KRW' } })
    fireEvent.change(screen.getByLabelText(/Home currency/i), { target: { value: 'USD' } })
    // budget deliberately left blank
    fireEvent.click(screen.getByRole('button', { name: /Start tracking/i }))

    await waitFor(() => expect(state.updated.length).toBe(1))
    expect(state.updated[0].monthly_budget).toBeNull()
    expect(state.updated[0].onboarded).toBe(true)
  })
})

describe('Add Transaction page', () => {
  function renderAdd() {
    state.session = { user: USER }
    state.profile = ONBOARDED
    return render(
      <AuthProvider>
        <AddTransactionPage />
      </AuthProvider>,
    )
  }

  it('defaults currency to the local currency and date to today', async () => {
    renderAdd()
    const currency = (await waitFor(() =>
      screen.getByLabelText(/^Currency$/i),
    )) as HTMLSelectElement
    expect(currency.value).toBe('KRW')

    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const date = screen.getByLabelText(/^Date$/i) as HTMLInputElement
    expect(date.value).toBe(today)
  })

  it('offers only expense categories, and swaps to income ones on toggle', async () => {
    renderAdd()
    // Wait for the seeded reference data to arrive, not just for the element.
    let options: (string | null)[] = []
    await waitFor(() => {
      options = Array.from(
        (screen.getByLabelText(/^Category$/i) as HTMLSelectElement).options,
      ).map((o) => o.textContent)
      expect(options.length).toBeGreaterThan(0)
    })
    expect(options).toEqual(['Food', 'Transport'])

    fireEvent.click(screen.getByRole('button', { name: /^income$/i }))
    await waitFor(() => {
      options = Array.from(
        (screen.getByLabelText(/^Category$/i) as HTMLSelectElement).options,
      ).map((o) => o.textContent)
      expect(options).toEqual(['Allowance'])
    })
  })

  it('rejects an empty amount without saving', async () => {
    renderAdd()
    await waitFor(() => screen.getByLabelText(/^Title$/i))
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: 'Lunch' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    await waitFor(() => expect(screen.getByText(/Enter an amount/i)).toBeDefined())
    expect(state.inserted.length).toBe(0)
  })

  it('rejects a zero amount without saving', async () => {
    renderAdd()
    await waitFor(() => screen.getByLabelText(/^Amount$/i))
    fireEvent.change(screen.getByLabelText(/^Amount$/i), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: 'Lunch' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    // The inline hint and the submit error can both be present.
    await waitFor(() =>
      expect(screen.getAllByText(/greater than 0/i).length).toBeGreaterThan(0),
    )
    expect(state.inserted.length).toBe(0)
  })

  it('rejects decimals on a zero-decimal currency, before sending', async () => {
    // The mocked profile uses KRW, which has no minor unit, so any fraction is
    // invalid — the client mirrors the server rule and blocks the send.
    renderAdd()
    await waitFor(() => screen.getByLabelText(/^Amount$/i))
    fireEvent.change(screen.getByLabelText(/^Amount$/i), { target: { value: '2.675' } })
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: 'Lunch' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    await waitFor(() =>
      expect(screen.getAllByText(/no decimal unit/i).length).toBeGreaterThan(0),
    )
    expect(state.inserted.length).toBe(0)
  })

  it('rejects a whitespace-only title', async () => {
    // A blank title is caught by the native `required` attribute, so exercise
    // the JS guard with whitespace, which passes validation but is still empty.
    renderAdd()
    await waitFor(() => screen.getByLabelText(/^Amount$/i))
    fireEvent.change(screen.getByLabelText(/^Amount$/i), { target: { value: '5000' } })
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    await waitFor(() => expect(screen.getByText(/Title is required/i)).toBeDefined())
    expect(state.inserted.length).toBe(0)
  })

  it('saves with the authenticated user id and the chosen fields', async () => {
    renderAdd()
    // The payment method list must be populated before selecting from it.
    await waitFor(() => {
      const pm = screen.getByLabelText(/^Payment Method$/i) as HTMLSelectElement
      expect(pm.options.length).toBeGreaterThan(1)
    })
    fireEvent.change(screen.getByLabelText(/^Amount$/i), { target: { value: '12000' } })
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: 'Lunch' } })
    fireEvent.change(screen.getByLabelText(/^Payment Method$/i), { target: { value: 'p2' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    await waitFor(() => expect(state.inserted.length).toBe(1))
    const row = state.inserted[0]
    expect(row.user_id).toBe('u1')
    // Sent as an exact decimal STRING, never a JS number, so no float error can
    // enter the money path.
    expect(row.amount).toBe('12000')
    expect(typeof row.amount).toBe('string')
    expect(row.currency).toBe('KRW')
    expect(row.title).toBe('Lunch')
    expect(row.transaction_type).toBe('expense')
    expect(row.payment_method_id).toBe('p2')
    expect(row.description).toBeNull() // untouched optional field
  })

  it('shows a success message, clears amount and title, and stays on Add', async () => {
    renderAdd()
    await waitFor(() => screen.getByLabelText(/^Amount$/i))
    const amount = screen.getByLabelText(/^Amount$/i) as HTMLInputElement
    const title = screen.getByLabelText(/^Title$/i) as HTMLInputElement

    fireEvent.change(amount, { target: { value: '12000' } })
    fireEvent.change(title, { target: { value: 'Lunch' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    await waitFor(() => expect(screen.getByText(/Saved\./i)).toBeDefined())
    expect(amount.value).toBe('')
    expect(title.value).toBe('')
    // Still on Add, and currency/date kept for fast repeat entry
    expect(screen.getByText('Add Transaction')).toBeDefined()
    expect((screen.getByLabelText(/^Currency$/i) as HTMLSelectElement).value).toBe('KRW')
  })

  it('strips non-numeric characters from the amount', async () => {
    renderAdd()
    await waitFor(() => screen.getByLabelText(/^Amount$/i))
    const amount = screen.getByLabelText(/^Amount$/i) as HTMLInputElement
    fireEvent.change(amount, { target: { value: '12a,b00.5x' } })
    expect(amount.value).toBe('1200.5')
  })
})
