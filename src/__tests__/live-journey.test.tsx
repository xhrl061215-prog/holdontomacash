/**
 * Drives the REAL UI (no mocks) against the REAL running API, to confirm the
 * browser journey works end to end and not just the HTTP endpoints.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import App from '../App'

const API = 'http://localhost:5173/api-proxy'
const EMAIL = `ui-journey-${Date.now()}@example.com`
const PW = 'testpass123'

// The adapter reads VITE_API_URL; point it at the live server.
beforeAll(() => {
  localStorage.clear()
})

describe('live UI journey against the running backend', () => {
  it('signs up, onboards, adds a transaction, signs out and back in with data intact', async () => {
    const { unmount } = render(<App />)

    // --- sign up ---
    await waitFor(() => expect(screen.getByPlaceholderText(/Email/i)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^Sign up$/i }))
    fireEvent.change(screen.getByPlaceholderText(/Email/i), { target: { value: EMAIL } })
    fireEvent.change(screen.getByPlaceholderText(/Password/i), { target: { value: PW } })
    fireEvent.click(screen.getByRole('button', { name: /Create account/i }))

    // --- onboarding appears ---
    await waitFor(
      () => expect(screen.getByText('Set up your budget')).toBeDefined(),
      { timeout: 15000 },
    )

    fireEvent.change(screen.getByLabelText(/Study country/i), { target: { value: 'KR' } })
    fireEvent.change(screen.getByLabelText(/Local currency/i), { target: { value: 'KRW' } })
    fireEvent.change(screen.getByLabelText(/Home currency/i), { target: { value: 'USD' } })
    // budget deliberately blank — must remain optional
    fireEvent.click(screen.getByRole('button', { name: /Start tracking/i }))

    // --- lands on Add, currency prefilled from local currency ---
    await waitFor(
      () => expect(screen.getByText('Add Transaction')).toBeDefined(),
      { timeout: 15000 },
    )
    await waitFor(() => {
      const cur = screen.getByLabelText(/^Currency$/i) as HTMLSelectElement
      expect(cur.value).toBe('KRW')
    }, { timeout: 10000 })

    // categories arrived from the signup trigger
    await waitFor(() => {
      const cat = screen.getByLabelText(/^Category$/i) as HTMLSelectElement
      expect(cat.options.length).toBeGreaterThan(0)
    }, { timeout: 10000 })

    // --- add a transaction ---
    fireEvent.change(screen.getByLabelText(/^Amount$/i), { target: { value: '12000' } })
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: 'Lunch at cafe' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Transaction/i }))

    // --- success state, form reset, still on Add ---
    await waitFor(() => expect(screen.getByText(/Saved\./i)).toBeDefined(), { timeout: 15000 })
    expect((screen.getByLabelText(/^Amount$/i) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/^Title$/i) as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Add Transaction')).toBeDefined()

    // --- sign out ---
    fireEvent.click(screen.getAllByRole('button', { name: /Sign out/i })[0])
    await waitFor(
      () => expect(screen.getByPlaceholderText(/Email/i)).toBeDefined(),
      { timeout: 15000 },
    )
    unmount()

    // --- sign back in on a fresh mount ---
    render(<App />)
    await waitFor(() => expect(screen.getByPlaceholderText(/Email/i)).toBeDefined())
    fireEvent.change(screen.getByPlaceholderText(/Email/i), { target: { value: EMAIL } })
    fireEvent.change(screen.getByPlaceholderText(/Password/i), { target: { value: PW } })
    // Both the mode tab and the submit button read "Sign in"; submit is the
    // type=submit one.
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /^Sign in$/i })
        .find((b) => b.getAttribute('type') === 'submit')!,
    )

    // straight to Add — no repeat onboarding
    await waitFor(
      () => expect(screen.getByText('Add Transaction')).toBeDefined(),
      { timeout: 15000 },
    )
    expect(screen.queryByText('Set up your budget')).toBeNull()

    // the saved transaction survived, verified through the API the UI uses
    const token = localStorage.getItem('bt:token')
    const res = await fetch(`${API}/api/transactions`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const { transactions } = await res.json()
    expect(transactions.length).toBe(1)
    expect(transactions[0].title).toBe('Lunch at cafe')
    expect(Number(transactions[0].amount)).toBe(12000)
  }, 90000)
})
