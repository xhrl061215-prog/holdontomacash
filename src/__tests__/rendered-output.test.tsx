/**
 * Rendered-output sanity: does the screen make sense to a person?
 *
 * The budget-currency defect motivated this file. Every layer was internally
 * correct — exact arithmetic, reachable inputs, guards that failed when broken —
 * and the product still displayed "965132.4% of your budget", because the UNIT
 * was wrong. No consistency check catches that; only reading the output as a user
 * would.
 *
 * So these tests assert on what is actually rendered: currencies are labelled,
 * figures are plausible, and no sentence contains an absurd number.
 *
 * Requires the API running (npm run dev:all).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OverviewPage } from '../pages/OverviewPage'
import { OnboardingPage } from '../pages/OnboardingPage'
import { AuthProvider } from '../context/AuthContext'

const API = 'http://localhost:5173/api-proxy'

async function seedUser(opts: {
  local: string; home: string; budget: string | null; spend: string
}) {
  const signup = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `render-${Math.random().toString(36).slice(2)}-${Date.now()}@example.com`,
      password: 'testpass123',
    }),
  }).then((r) => r.json())

  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${signup.token}` }

  await fetch(`${API}/api/profile`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({
      study_country: 'XX', local_currency: opts.local, home_currency: opts.home,
      display_currency: opts.home, monthly_budget: opts.budget,
      budget_currency: opts.budget === null ? null : opts.local, onboarded: true,
    }),
  })

  const cats = await fetch(`${API}/api/categories`, { headers: h }).then((r) => r.json())
  const food = cats.categories.find((c: any) => c.name === 'Groceries' && c.type === 'expense')

  const d = new Date()
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  await fetch(`${API}/api/transactions`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      transaction_type: 'expense', amount: opts.spend, currency: opts.local,
      transaction_date: `${month}-01`, category_id: food.id, title: 'rent share',
    }),
  })

  localStorage.setItem('bt:token', signup.token)
  return { token: signup.token }
}

const renderOverview = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <OverviewPage />
      </AuthProvider>
    </MemoryRouter>,
  )

/** Any percentage of four or more digits is a unit error, not a spending habit. */
function findAbsurdPercentages(text: string): string[] {
  return text.match(/\b\d{4,}(\.\d+)?%/g) ?? []
}

// ---------------------------------------------------------------------------

describe('Overview reads sensibly for a student abroad', () => {
  beforeAll(() => localStorage.clear())

  it('shows a plausible budget, not a six-digit percentage', async () => {
    // The exact reported scenario: London student, GBP1,500 budget, GBP400 spent,
    // reporting in KRW.
    await seedUser({ local: 'GBP', home: 'KRW', budget: '1500', spend: '400.00' })
    renderOverview()

    await waitFor(() => expect(screen.getByText('Budget left')).toBeDefined(), {
      timeout: 15000,
    })

    const body = document.body.textContent ?? ''
    expect(
      findAbsurdPercentages(body),
      `absurd percentage on screen: ${findAbsurdPercentages(body).join(', ')}`,
    ).toEqual([])

    // The figure the user typed is recognisable on screen, with its currency.
    // GBP renders with 2 decimals, so match the value and code without assuming
    // a particular precision.
    expect(body).toMatch(/1,500(\.00)? GBP/)

    // And the comparable budget is the CONVERTED figure, far above the raw 1500.
    const budgetCard = screen.getByText('Budget left').closest('div')!
    const cardText = budgetCard.textContent ?? ''
    expect(cardText).toMatch(/of [\d,]{7,} KRW/) // 7+ chars => millions
  }, 60000)

  it('labels every money figure with a currency', async () => {
    await seedUser({ local: 'GBP', home: 'KRW', budget: '1500', spend: '400.00' })
    renderOverview()
    await waitFor(() => expect(screen.getByText('Spent')).toBeDefined(), { timeout: 15000 })

    // Each of the four cards names its currency, so no figure is ambiguous.
    for (const label of ['Spent', 'Income', 'Net']) {
      const card = screen.getByText(label).closest('div')!
      expect(within(card).getByText('KRW')).toBeDefined()
    }
  }, 60000)

  it('offers to set a budget instead of showing a misleading zero', async () => {
    await seedUser({ local: 'GBP', home: 'KRW', budget: null, spend: '400.00' })
    renderOverview()
    await waitFor(() => expect(screen.getByText('Budget left')).toBeDefined(), {
      timeout: 15000,
    })

    expect(screen.getByText(/No budget set/i)).toBeDefined()
    const card = screen.getByText('Budget left').closest('div')!
    // Must not render a 0 figure where a budget would go.
    expect(within(card).queryByText(/^0$/)).toBeNull()
    expect(within(card).queryByText(/^0\.00$/)).toBeNull()
  }, 60000)

  it('never renders NaN, Infinity, undefined or null as a value', async () => {
    for (const combo of [
      { local: 'GBP', home: 'KRW', budget: '1500', spend: '400.00' },
      { local: 'JPY', home: 'GBP', budget: '150000', spend: '20000' },
      { local: 'KRW', home: 'KRW', budget: '2000000', spend: '500000' },
      { local: 'USD', home: 'JPY', budget: null, spend: '25.00' },
    ]) {
      localStorage.clear()
      await seedUser(combo)
      const { unmount } = renderOverview()
      await waitFor(() => expect(screen.getByText('Spent')).toBeDefined(), { timeout: 15000 })

      const body = document.body.textContent ?? ''
      expect(body).not.toMatch(/NaN|Infinity|undefined|\bnull\b/)
      expect(findAbsurdPercentages(body)).toEqual([])
      unmount()
    }
  }, 120000)

  it('states which periods the comparison covers', async () => {
    await seedUser({ local: 'GBP', home: 'KRW', budget: '1500', spend: '400.00' })
    renderOverview()
    await waitFor(() => expect(screen.getByText(/Comparing/i)).toBeDefined(), {
      timeout: 15000,
    })
    // Named months and explicit day ranges, so it cannot be read as whole-month.
    expect(screen.getByText(/Comparing 1–\d+ \w+ with 1–\d+ \w+/)).toBeDefined()
  }, 60000)

  it('renders consultant insights as plain sentences with real figures', async () => {
    await seedUser({ local: 'GBP', home: 'KRW', budget: '1500', spend: '400.00' })
    renderOverview()
    await waitFor(() => expect(screen.getByText('Budget Consultant')).toBeDefined(), {
      timeout: 15000,
    })

    const section = screen.getByText('Budget Consultant').closest('div')!
    const text = section.textContent ?? ''
    expect(findAbsurdPercentages(text)).toEqual([])
    expect(text).not.toMatch(/NaN|Infinity|undefined/)
    // No moralising.
    expect(text).not.toMatch(/you should|wasteful|too much|great job|well done/i)
  }, 60000)
})

describe('onboarding names the budget currency', () => {
  beforeAll(() => localStorage.clear())

  it('shows the currency in the label and as a prefix once local currency is chosen', async () => {
    // An unlabelled money input is a bug regardless of what sits behind it.
    const signup = await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `onb-${Date.now()}@example.com`, password: 'testpass123',
      }),
    }).then((r) => r.json())
    localStorage.setItem('bt:token', signup.token)

    const { default: userEventDefault } = await import('@testing-library/user-event')
    const user = userEventDefault.setup()

    render(
      <MemoryRouter>
        <AuthProvider>
          <OnboardingPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Set up your budget')).toBeDefined(), {
      timeout: 15000,
    })

    // Before choosing a currency the field says so rather than implying one.
    expect(screen.getByPlaceholderText(/Pick your local currency first/i)).toBeDefined()

    await user.selectOptions(screen.getByLabelText(/Local currency/i), 'GBP')
    await user.selectOptions(screen.getByLabelText(/Home currency/i), 'KRW')

    // Label names the currency the budget is set in.
    expect(screen.getByLabelText(/Monthly budget \(GBP\)/i)).toBeDefined()
    // And the hint explains the conversion, so the basis is never implicit.
    expect(screen.getByText(/Set this in GBP.*converted to KRW/i)).toBeDefined()
  }, 60000)
})
