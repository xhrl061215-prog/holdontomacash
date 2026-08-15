// Domain types — mirror the PostgreSQL schema in supabase/migrations/

export type TransactionType = 'expense' | 'income'

export interface Profile {
  id: string
  study_country: string | null
  local_currency: string | null
  home_currency: string | null
  display_currency: string | null
  /** null = no budget set (distinct from a budget of 0) */
  monthly_budget: number | null
  onboarded: boolean
  created_at: string
  updated_at: string
}

export interface Category {
  id: string
  user_id: string
  name: string
  type: TransactionType
  is_default: boolean
  sort_order: number
  created_at: string
}

export interface PaymentMethod {
  id: string
  user_id: string
  name: string
  is_default: boolean
  sort_order: number
  created_at: string
}

export interface Transaction {
  id: string
  user_id: string
  transaction_type: TransactionType
  amount: number
  currency: string
  transaction_date: string
  category_id: string | null
  title: string
  description: string | null
  payment_method_id: string | null
  created_at: string
  updated_at: string
  // Reserved for the currency-conversion phase; always null in Phase 1.
  converted_amount: number | null
  converted_currency: string | null
  exchange_rate: number | null
}
