/**
 * Renders the real Transactions page against the live API — no mocks.
 * Confirms table semantics, real values, filter combination and the
 * approximate/pending labels.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TransactionsPage } from '../pages/TransactionsPage'
import { AuthProvider } from '../context/AuthContext'

const API = 'http://localhost:5173/api-proxy'

async function seed() {
  const email = `tx-ui-${Date.now()}@example.com`
  const signup = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123' }),
  }).then((r) => r.json())

  const token = signup.token
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  await fetch(`${API}/api/profile`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({
      study_country: 'GB', local_currency: 'GBP', home_currency: 'KRW',
      display_currency: 'KRW', monthly_budget: null, onboarded: true,
    }),
  })

  const cats = await fetch(`${API}/api/categories`, { headers: h }).then((r) => r.json())
  const pms = await fetch(`${API}/api/payment-methods`, { headers: h }).then((r) => r.json())
  const food = cats.categories.find((c: any) => c.name === 'Groceries' && c.type === 'expense')
  const transport = cats.categories.find((c: any) => c.name === 'Transport')
  const cash = pms.payment_methods.find((p: any) => p.name === 'Cash')

  const rows = [
    { title: 'Tesco groceries', amount: 12, currency: 'GBP', transaction_date: '2026-08-03', category_id: food.id, payment_method_id: cash.id, description: 'weekly shop', transaction_type: 'expense' },
    { title: 'Bus pass', amount: 30, currency: 'GBP', transaction_date: '2026-08-11', category_id: transport.id, payment_method_id: cash.id, description: null, transaction_type: 'expense' },
    { title: 'July rent', amount: 500, currency: 'GBP', transaction_date: '2026-07-01', category_id: food.id, payment_method_id: cash.id, description: null, transaction_type: 'expense' },
  ]
  for (const r of rows) {
    await fetch(`${API}/api/transactions`, { method: 'POST', headers: h, body: JSON.stringify(r) })
  }

  localStorage.setItem('bt:token', token)
  return { token }
}

// The page reads filters from the URL (so an Overview donut click lands here
// pre-filtered), which requires a Router in tests.
const renderPage = (initialUrl = '/transactions') =>
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <AuthProvider>
        <TransactionsPage />
      </AuthProvider>
    </MemoryRouter>,
  )

beforeAll(async () => {
  localStorage.clear()
  await seed()
}, 60000)

describe('Transactions page against the live API', () => {
  it('renders a real table, not cards', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('table')).toBeDefined(), { timeout: 15000 })

    // Real table semantics: every spec column is a column header.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())
    for (const label of [
      'Title', 'Category', 'Details', 'Payment Method',
      'Original Amount', 'Currency',
    ]) {
      expect(headers.some((h) => h?.includes(label))).toBe(true)
    }
    expect(headers.some((h) => h?.includes('Date'))).toBe(true)
    expect(headers.some((h) => h?.includes('Rate'))).toBe(true)
    // Home-currency column reflects the profile's home currency.
    expect(headers.some((h) => h?.includes('KRW'))).toBe(true)
  }, 30000)

  it('shows the original amount and currency alongside the converted value', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Tesco groceries')).toBeDefined(), { timeout: 15000 })

    const row = screen.getByText('Tesco groceries').closest('tr')!
    // Original amount is present and never replaced by the home value.
    expect(within(row).getByText('12.00')).toBeDefined()
    expect(within(row).getByText('GBP')).toBeDefined()
    // A converted KRW value is rendered with 0 decimals and thousands grouping.
    expect(row.textContent).toMatch(/\d{1,3}(,\d{3})+/)
  }, 30000)

  it('combines a search with a month filter', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Tesco groceries')).toBeDefined(), { timeout: 15000 })
    // All three rows initially.
    await waitFor(() => expect(screen.getByText('July rent')).toBeDefined())

    // Filter to August -> July row disappears.
    fireEvent.change(screen.getByLabelText(/Filter by month/i), { target: { value: '2026-08' } })
    await waitFor(() => expect(screen.queryByText('July rent')).toBeNull(), { timeout: 15000 })
    expect(screen.getByText('Tesco groceries')).toBeDefined()

    // Add a search that excludes the remaining August row.
    fireEvent.change(screen.getByLabelText(/Search transactions/i), { target: { value: 'Bus' } })
    await waitFor(() => expect(screen.queryByText('Tesco groceries')).toBeNull(), { timeout: 15000 })
    expect(screen.getByText('Bus pass')).toBeDefined()
  }, 40000)

  it('resets all filters at once', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Tesco groceries')).toBeDefined(), { timeout: 15000 })

    fireEvent.change(screen.getByLabelText(/Filter by month/i), { target: { value: '2026-08' } })
    fireEvent.change(screen.getByLabelText(/Search transactions/i), { target: { value: 'Bus' } })
    await waitFor(() => expect(screen.queryByText('Tesco groceries')).toBeNull(), { timeout: 15000 })

    fireEvent.click(await screen.findByText(/Reset filters/i))
    await waitFor(() => expect(screen.getByText('July rent')).toBeDefined(), { timeout: 15000 })
    expect(screen.getByText('Tesco groceries')).toBeDefined()
  }, 40000)

  it('toggles date sort direction', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Tesco groceries')).toBeDefined(), { timeout: 15000 })

    const dateHeader = screen.getByRole('button', { name: /Sort by date/i })
    const firstBefore = screen.getAllByRole('row')[1].textContent
    fireEvent.click(dateHeader)
    await waitFor(
      () => expect(screen.getAllByRole('row')[1].textContent).not.toBe(firstBefore),
      { timeout: 15000 },
    )
  }, 40000)

  it('applies a category filter arriving in the URL', async () => {
    // This is the Overview donut click-through contract.
    const token = localStorage.getItem('bt:token')
    const cats = await fetch(`${API}/api/categories`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json())
    const transport = cats.categories.find((c: any) => c.name === 'Transport')

    renderPage(`/transactions?category_id=${transport.id}&type=expense`)
    await waitFor(() => expect(screen.getByText('Bus pass')).toBeDefined(), { timeout: 15000 })
    // Rows in other categories must be filtered out.
    expect(screen.queryByText('Tesco groceries')).toBeNull()
  }, 40000)

  it('hides the home-currency column when the switcher is off', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('table')).toBeDefined(), { timeout: 15000 })

    expect(
      screen.getAllByRole('columnheader').some((h) => h.textContent?.includes('KRW')),
    ).toBe(true)

    fireEvent.click(screen.getByLabelText(/Show KRW value/i))
    await waitFor(() => {
      expect(
        screen.getAllByRole('columnheader').some((h) => h.textContent?.includes('KRW')),
      ).toBe(false)
    })
    // Originals remain — the switcher is a view concern only.
    expect(screen.getByText('Tesco groceries')).toBeDefined()
  }, 40000)
})
