/**
 * Requirements-conformance tests: does the app's CONTENT match what was asked
 * for, not merely behave correctly?
 *
 * Motivation: four rounds of review verified arithmetic and behaviour, and every
 * one passed while the seeded categories had been quietly substituted — Food for
 * Eating Out, Education for Academic, Utilities invented, and Subscription,
 * Salary, Refund and Global / Travel Card simply missing. Code correct, tests
 * green, requirements silently changed.
 *
 * These lists are transcribed from the project brief. They are the specification,
 * not a paraphrase, so a future well-meaning rename fails here rather than
 * shipping.
 *
 * Requires the API running (npm run dev:all).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { DEFAULT_CATEGORIES, DEFAULT_PAYMENT_METHODS } from '../lib/seedData'

const API = 'http://localhost:5173/api-proxy'

/** Verbatim from the brief, PAGE 1 — ADD TRANSACTION. */
const BRIEF_EXPENSE_CATEGORIES = [
  'Groceries',
  'Eating Out',
  'Academic',
  'Entertainment / Nightlife',
  'Transport',
  'Phone / Internet',
  'Housing / Living',
  'Shopping',
  'Health',
  'Travel',
  'Subscription',
  'Other',
]

const BRIEF_INCOME_CATEGORIES = [
  'Allowance',
  'Salary',
  'Scholarship',
  'Refund',
  'Other',
]

const BRIEF_PAYMENT_METHODS = [
  'Debit Card',
  'Credit Card',
  'Global / Travel Card',
  'Cash',
  'Bank Transfer',
  'Other',
]

let token: string
let categories: any[]
let paymentMethods: any[]

beforeAll(async () => {
  const signup = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `conform-${Date.now()}@example.com`,
      password: 'testpass123',
    }),
  }).then((r) => r.json())
  token = signup.token
  const h = { Authorization: `Bearer ${token}` }
  categories = (await fetch(`${API}/api/categories`, { headers: h }).then((r) => r.json()))
    .categories
  paymentMethods = (await fetch(`${API}/api/payment-methods`, { headers: h }).then((r) =>
    r.json(),
  )).payment_methods
}, 60000)

describe('seeded categories match the brief', () => {
  it('seeds exactly the brief expense categories, in order', () => {
    const seeded = categories
      .filter((c) => c.type === 'expense')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => c.name)
    expect(seeded).toEqual(BRIEF_EXPENSE_CATEGORIES)
  })

  it('seeds exactly the brief income categories, in order', () => {
    const seeded = categories
      .filter((c) => c.type === 'income')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => c.name)
    expect(seeded).toEqual(BRIEF_INCOME_CATEGORIES)
  })

  // Named individually so a regression report says WHICH requirement was dropped.
  it.each(BRIEF_EXPENSE_CATEGORIES)('expense category "%s" exists', (name) => {
    expect(categories.some((c) => c.type === 'expense' && c.name === name)).toBe(true)
  })

  it.each(BRIEF_INCOME_CATEGORIES)('income category "%s" exists', (name) => {
    expect(categories.some((c) => c.type === 'income' && c.name === name)).toBe(true)
  })

  it('invents no categories the brief did not ask for', () => {
    const invented = categories.filter(
      (c) =>
        !(c.type === 'expense'
          ? BRIEF_EXPENSE_CATEGORIES
          : BRIEF_INCOME_CATEGORIES
        ).includes(c.name),
    )
    expect(
      invented.map((c) => `${c.name} (${c.type})`),
      'categories present that were never requested',
    ).toEqual([])
  })
})

describe('seeded payment methods match the brief', () => {
  it('seeds exactly the brief payment methods, in order', () => {
    const seeded = paymentMethods
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => p.name)
    expect(seeded).toEqual(BRIEF_PAYMENT_METHODS)
  })

  it.each(BRIEF_PAYMENT_METHODS)('payment method "%s" exists', (name) => {
    expect(paymentMethods.some((p) => p.name === name)).toBe(true)
  })

  it('includes Global / Travel Card, the product\'s differentiating case', () => {
    // The target user "uses Wise/Revolut/global travel cards"; multi-currency
    // spending is the whole point of the product.
    expect(paymentMethods.some((p) => p.name === 'Global / Travel Card')).toBe(true)
  })

  it('has exactly one default payment method', () => {
    expect(paymentMethods.filter((p) => p.is_default).length).toBe(1)
  })
})

describe('structural requirements that depend on specific categories', () => {
  it('supports recording a refund as income, per the financial rules', async () => {
    // The rule is "a refund is income with a refund category". Without a Refund
    // category that rule has nowhere to land.
    const refund = categories.find((c) => c.type === 'income' && c.name === 'Refund')
    expect(refund).toBeDefined()

    const d = new Date()
    const res = await fetch(`${API}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        transaction_type: 'income',
        amount: '25.00',
        currency: 'GBP',
        transaction_date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
        category_id: refund.id,
        title: 'Returned textbook',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.transaction.transaction_type).toBe('income')
    expect(body.transaction.category_id).toBe(refund.id)
  }, 30000)

  it('supports a subscription expense on a travel card', async () => {
    const sub = categories.find((c) => c.type === 'expense' && c.name === 'Subscription')
    const travel = paymentMethods.find((p) => p.name === 'Global / Travel Card')
    expect(sub).toBeDefined()
    expect(travel).toBeDefined()

    const d = new Date()
    const res = await fetch(`${API}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        transaction_type: 'expense',
        amount: '9.99',
        currency: 'GBP',
        transaction_date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-02`,
        category_id: sub.id,
        payment_method_id: travel.id,
        title: 'Spotify',
      }),
    })
    expect(res.status).toBe(200)
  }, 30000)
})

describe('the client seed constants agree with the database', () => {
  // Two sources of the same list can drift; assert they cannot.
  it('client expense constants match the brief', () => {
    const client = DEFAULT_CATEGORIES.filter((c) => c.type === 'expense')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => c.name)
    expect(client).toEqual(BRIEF_EXPENSE_CATEGORIES)
  })

  it('client income constants match the brief', () => {
    const client = DEFAULT_CATEGORIES.filter((c) => c.type === 'income')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => c.name)
    expect(client).toEqual(BRIEF_INCOME_CATEGORIES)
  })

  it('client payment method constants match the brief', () => {
    const client = [...DEFAULT_PAYMENT_METHODS]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => p.name)
    expect(client).toEqual(BRIEF_PAYMENT_METHODS)
  })

  it('client constants and seeded database rows are identical', () => {
    const clientExpense = DEFAULT_CATEGORIES.filter((c) => c.type === 'expense')
      .map((c) => c.name).sort()
    const dbExpense = categories.filter((c) => c.type === 'expense')
      .map((c) => c.name).sort()
    expect(dbExpense).toEqual(clientExpense)
  })
})
