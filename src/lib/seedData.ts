// Default categories & payment methods created automatically on signup.
// Per PRD assumption #4: default seed only; user-custom categories are post-MVP.

export interface SeedCategory {
  name: string
  type: 'expense' | 'income'
  is_default: boolean
  sort_order: number
}

export interface SeedPaymentMethod {
  name: string
  is_default: boolean
  sort_order: number
}

/**
 * Seeded on signup, matching the brief's lists verbatim and in its order.
 *
 * The names and ordering are taken directly from the project brief rather than
 * paraphrased. An earlier version substituted plausible-sounding equivalents
 * (Food for Eating Out, Education for Academic) and invented others (Utilities,
 * Mobile Payment) while dropping Subscription, Salary, Refund and
 * Global / Travel Card. Those were requirements, not suggestions.
 *
 * Two of the losses mattered structurally:
 *   - Refund: a refund is recorded as income, so without this category that
 *     rule has nowhere to land.
 *   - Global / Travel Card: the target user "uses Wise/Revolut/global travel
 *     cards", and multi-currency spending is the product's differentiator.
 */
export const DEFAULT_CATEGORIES: SeedCategory[] = [
  // Expense — the brief's list, in the brief's order.
  { name: 'Groceries', type: 'expense', is_default: true, sort_order: 1 },
  { name: 'Eating Out', type: 'expense', is_default: true, sort_order: 2 },
  { name: 'Academic', type: 'expense', is_default: true, sort_order: 3 },
  { name: 'Entertainment / Nightlife', type: 'expense', is_default: true, sort_order: 4 },
  { name: 'Transport', type: 'expense', is_default: true, sort_order: 5 },
  { name: 'Phone / Internet', type: 'expense', is_default: true, sort_order: 6 },
  { name: 'Housing / Living', type: 'expense', is_default: true, sort_order: 7 },
  { name: 'Shopping', type: 'expense', is_default: true, sort_order: 8 },
  { name: 'Health', type: 'expense', is_default: true, sort_order: 9 },
  { name: 'Travel', type: 'expense', is_default: true, sort_order: 10 },
  { name: 'Subscription', type: 'expense', is_default: true, sort_order: 11 },
  { name: 'Other', type: 'expense', is_default: true, sort_order: 12 },
  // Income — the brief's list, in the brief's order.
  { name: 'Allowance', type: 'income', is_default: true, sort_order: 1 },
  { name: 'Salary', type: 'income', is_default: true, sort_order: 2 },
  { name: 'Scholarship', type: 'income', is_default: true, sort_order: 3 },
  { name: 'Refund', type: 'income', is_default: true, sort_order: 4 },
  { name: 'Other', type: 'income', is_default: true, sort_order: 5 },
]

export const DEFAULT_PAYMENT_METHODS: SeedPaymentMethod[] = [
  // The brief's list, in the brief's order. Debit Card is the default because
  // it leads the brief's examples and is the common case for a student abroad.
  { name: 'Debit Card', is_default: true, sort_order: 1 },
  { name: 'Credit Card', is_default: false, sort_order: 2 },
  { name: 'Global / Travel Card', is_default: false, sort_order: 3 },
  { name: 'Cash', is_default: false, sort_order: 4 },
  { name: 'Bank Transfer', is_default: false, sort_order: 5 },
  { name: 'Other', is_default: false, sort_order: 6 },
]

export const COMMON_CURRENCIES: { code: string; name: string }[] = [
  { code: 'KRW', name: 'South Korean Won' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'THB', name: 'Thai Baht' },
  { code: 'VND', name: 'Vietnamese Dong' },
  { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'IDR', name: 'Indonesian Rupiah' },
  { code: 'PHP', name: 'Philippine Peso' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'PLN', name: 'Polish Zloty' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'RUB', name: 'Russian Ruble' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'SAR', name: 'Saudi Riyal' },
  { code: 'ZAR', name: 'South African Rand' },
]

export const COMMON_COUNTRIES: { code: string; name: string }[] = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'CN', name: 'China' },
  { code: 'SG', name: 'Singapore' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'IN', name: 'India' },
  { code: 'TH', name: 'Thailand' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'PH', name: 'Philippines' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'IE', name: 'Ireland' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' },
  { code: 'AE', name: 'United Arab Emirates' },
]
