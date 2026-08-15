/**
 * Real Supabase backend.
 *
 * `supabaseClient.ts` mirrors the slice of the Supabase API the pages use. This
 * module implements that same contract against hosted Supabase, so the pages,
 * hooks and tests are untouched by the switch.
 *
 * Active when both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set;
 * otherwise the preview API is used. That makes the two backends selectable by
 * configuration, not by editing code.
 *
 * What this buys over the preview backend:
 *   - data survives restarts and redeploys (hosted Postgres, not local PGlite)
 *   - sessions survive restarts (Supabase Auth refresh tokens in localStorage,
 *     not a Map in server memory)
 *   - row-level security is enforced by Postgres for every query, so isolation
 *     does not depend on this file being correct
 *
 * The anon key belongs in a browser build: RLS denies everything until a policy
 * matches the caller. The service_role key must never appear here.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Overview, OverviewCategory, TransactionFilters } from './supabaseClient'

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** True when hosted Supabase is configured. Read by supabaseClient.ts. */
export const isSupabaseConfigured = Boolean(URL && ANON)

let client: SupabaseClient | null = null
export function getClient(): SupabaseClient {
  if (!client) {
    if (!URL || !ANON) {
      throw new Error(
        'Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY',
      )
    }
    client = createClient(URL, ANON, {
      auth: {
        // The whole point of this backend: the session is persisted and silently
        // refreshed, so closing the tab or redeploying does not sign anyone out.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'bt:supabase:session',
      },
    })
  }
  return client
}

// ---------------------------------------------------------------------------
// auth — same shape as the preview adapter's `auth`
// ---------------------------------------------------------------------------

export const supabaseAuth = {
  async getSession() {
    const { data } = await getClient().auth.getSession()
    const u = data.session?.user
    return {
      data: {
        session: u ? { user: { id: u.id, email: u.email ?? '' } } : null,
      },
    }
  },

  onAuthStateChange(cb: (event: string, session: any) => void) {
    const { data } = getClient().auth.onAuthStateChange((event, session) => {
      const u = session?.user
      cb(event, u ? { user: { id: u.id, email: u.email ?? '' } } : null)
    })
    return { data: { subscription: data.subscription } }
  },

  async signUp({ email, password }: { email: string; password: string }) {
    const { data, error } = await getClient().auth.signUp({ email, password })
    if (error) return { data: { user: null, session: null }, error: { message: error.message } }
    const u = data.user
    return {
      data: {
        user: u ? { id: u.id, email: u.email ?? '' } : null,
        // With email confirmation enabled there is no session until confirmed.
        session: data.session && u ? { user: { id: u.id, email: u.email ?? '' } } : null,
      },
      error: null,
      // Surfaced so the UI can say "check your email" rather than appearing stuck.
      needsEmailConfirmation: Boolean(u && !data.session),
    }
  },

  async signInWithPassword({ email, password }: { email: string; password: string }) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password })
    if (error) return { data: { user: null, session: null }, error: { message: error.message } }
    const u = data.user
    return {
      data: {
        user: u ? { id: u.id, email: u.email ?? '' } : null,
        session: u ? { user: { id: u.id, email: u.email ?? '' } } : null,
      },
      error: null,
    }
  },

  async signOut() {
    const { error } = await getClient().auth.signOut()
    return { error: error ? { message: error.message } : null }
  },
}

// ---------------------------------------------------------------------------
// profile / categories / payment methods
// ---------------------------------------------------------------------------

async function requireUser() {
  const { data } = await getClient().auth.getUser()
  if (!data.user) throw new Error('Not signed in')
  return data.user
}

export const supabaseProfileApi = {
  async get() {
    const user = await requireUser()
    const { data, error } = await getClient()
      .from('profiles').select('*').eq('id', user.id).maybeSingle()
    if (error) throw new Error(error.message)
    return { profile: data }
  },

  async update(changes: Record<string, unknown>) {
    const user = await requireUser()
    const { data, error } = await getClient()
      .from('profiles').update(changes).eq('id', user.id).select().single()
    if (error) throw new Error(error.message)
    return { profile: data }
  },
}

export const supabaseCategoriesApi = {
  async list() {
    const { data, error } = await getClient()
      .from('categories').select('*').order('type').order('sort_order')
    if (error) throw new Error(error.message)
    return { categories: data ?? [] }
  },
}

export const supabasePaymentMethodsApi = {
  async list() {
    const { data, error } = await getClient()
      .from('payment_methods').select('*').order('sort_order')
    if (error) throw new Error(error.message)
    return { payment_methods: data ?? [] }
  },
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

export const supabaseTransactionsApi = {
  async list(filters: TransactionFilters = {}) {
    let q = getClient()
      .from('transactions')
      .select('*, categories(name), payment_methods(name)', { count: 'exact' })
      .order('transaction_date', { ascending: filters.sort !== 'date_asc' })
      .order('created_at', { ascending: false })
      .limit(500)

    if (filters.month) {
      // String bounds, never Date arithmetic: month buckets are calendar facts.
      const [y, m] = filters.month.split('-').map(Number)
      const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
      q = q.gte('transaction_date', `${filters.month}-01`).lt('transaction_date', end)
    }
    if (filters.category_id) q = q.eq('category_id', filters.category_id)
    if (filters.payment_method_id) q = q.eq('payment_method_id', filters.payment_method_id)
    if (filters.currency) q = q.eq('currency', filters.currency)
    // Field names must match TransactionFilters exactly: `type` and `q`, not
    // transaction_type/search. Guessing them would have shipped filters that
    // silently never applied.
    if (filters.type) q = q.eq('transaction_type', filters.type)
    if (filters.q) {
      // Strip PostgREST's or() metacharacters so a title cannot alter the query.
      const term = filters.q.replace(/[%,().*]/g, '')
      if (term) q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%`)
    }

    // `count: 'exact'` so `total` reflects ALL matching rows, not the 500 returned.
    // The pages display it, so an undefined here would render as blank.
    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return {
      transactions: (data ?? []).map((r: any) => ({
        ...r,
        category_name: r.categories?.name ?? null,
        payment_method_name: r.payment_methods?.name ?? null,
      })),
      total: count ?? (data ?? []).length,
    }
  },

  async create(row: Record<string, unknown>) {
    const user = await requireUser()
    const { data, error } = await getClient()
      .from('transactions').insert({ ...row, user_id: user.id }).select().single()
    if (error) throw new Error(error.message)
    return { transaction: data }
  },

  async update(id: string, changes: Record<string, unknown>) {
    const { data, error } = await getClient()
      .from('transactions').update(changes).eq('id', id).select().single()
    if (error) throw new Error(error.message)
    return { transaction: data }
  },

  async remove(id: string) {
    const { error } = await getClient().from('transactions').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { ok: true }
  },

  async usedCurrencies() {
    const { data, error } = await getClient().from('transactions').select('currency')
    if (error) throw new Error(error.message)
    return { currencies: [...new Set((data ?? []).map((r: any) => r.currency))].sort() }
  },

  async usedMonths() {
    const { data, error } = await getClient().from('transactions').select('transaction_date')
    if (error) throw new Error(error.message)
    // Slice the string; never construct a Date, which would shift across zones.
    const months = [...new Set((data ?? []).map((r: any) => String(r.transaction_date).slice(0, 7)))]
    return { months: months.sort().reverse() }
  },

  async backfill(limit = 25) {
    // Conversion is server-side work; the hosted deployment runs it as an Edge
    // Function. Reported honestly rather than silently doing nothing.
    const { data, error } = await getClient().functions.invoke('backfill-rates', {
      body: { limit },
    })
    if (error) throw new Error(error.message)
    return data ?? { updated: 0 }
  },
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

export const supabaseOverviewApi = {
  async get(month?: string): Promise<Overview> {
    // Aggregation stays in SQL so it covers every row, not the 500-row page.
    const { data, error } = await getClient().rpc('overview_for_month', {
      p_month: month ?? new Date().toISOString().slice(0, 7),
    })
    if (error) throw new Error(error.message)
    return data as Overview
  },
}

export type { Overview, OverviewCategory, TransactionFilters }
