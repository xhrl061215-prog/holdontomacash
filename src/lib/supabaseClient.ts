/**
 * Backend adapter — selects between two real backends by configuration.
 *
 * Exposes the small slice of the Supabase client surface the pages use. Two
 * implementations sit behind it:
 *
 *   preview  (default)  server/index.mjs — Postgres via PGlite, in-process.
 *                       Sessions live in server memory, data in a local
 *                       directory: fine for evaluation, not durable.
 *   hosted              supabaseBackend.ts — hosted Supabase. Data and sessions
 *                       both survive restarts and redeploys.
 *
 * Hosted is used when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are both set.
 * Pages, hooks and tests import from this module only, so neither backend is
 * visible to them.
 */
import {
  isSupabaseConfigured,
  supabaseAuth,
  supabaseTransactionsApi,
  supabaseOverviewApi,
  supabaseCategoriesApi,
  supabasePaymentMethodsApi,
  supabaseProfileApi,
} from './supabaseBackend'

/**
 * Which backend is live. Exported so the UI can state it rather than imply it.
 *
 * 'unconfigured' is distinct from 'preview': the preview API is a real working
 * backend for local development, whereas a deployed build with no Supabase config
 * and no preview server reachable has nowhere to store anything, and should say so
 * instead of failing later at sign-up.
 */
export const backendMode: 'hosted' | 'preview' | 'unconfigured' = isSupabaseConfigured
  ? 'hosted'
  : import.meta.env.PROD && !import.meta.env.VITE_API_URL
    ? 'unconfigured'
    : 'preview'

const API = import.meta.env.VITE_API_URL || '/api-proxy'
const TOKEN_KEY = 'bt:token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
const clearToken = () => localStorage.removeItem(TOKEN_KEY)

async function request(path: string, options: RequestInit = {}) {
  const token = getToken()
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

type AuthListener = (event: string, session: Session | null) => void
interface Session {
  user: { id: string; email: string }
}

const listeners = new Set<AuthListener>()
let currentSession: Session | null = null

function emit(event: string) {
  listeners.forEach((l) => l(event, currentSession))
}

const previewAuth = {
  async getSession(): Promise<{ data: { session: Session | null } }> {
    if (!getToken()) {
      currentSession = null
      return { data: { session: null } }
    }
    try {
      const { user } = await request('/auth/me')
      currentSession = user ? { user } : null
    } catch {
      clearToken()
      currentSession = null
    }
    return { data: { session: currentSession } }
  },

  onAuthStateChange(cb: AuthListener) {
    listeners.add(cb)
    return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }
  },

  async signUp({ email, password }: { email: string; password: string }) {
    try {
      const { token, user } = await request('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      setToken(token)
      currentSession = { user }
      emit('SIGNED_IN')
      return { data: { user, session: currentSession }, error: null }
    } catch (e: any) {
      return { data: { user: null, session: null }, error: { message: e.message } }
    }
  },

  async signInWithPassword({ email, password }: { email: string; password: string }) {
    try {
      const { token, user } = await request('/auth/signin', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      setToken(token)
      currentSession = { user }
      emit('SIGNED_IN')
      return { data: { user, session: currentSession }, error: null }
    } catch (e: any) {
      return { data: { user: null, session: null }, error: { message: e.message } }
    }
  },

  async signOut() {
    try {
      await request('/auth/signout', { method: 'POST' })
    } catch {
      // Signing out locally matters even if the server call fails.
    }
    clearToken()
    currentSession = null
    emit('SIGNED_OUT')
    return { error: null }
  },
}

/** Minimal query-builder shim matching the `.from(...)` calls the pages make. */
function from(table: string) {
  const builder: any = {
    _order: null as string | null,

    select() {
      return builder
    },
    eq() {
      return builder
    },
    order() {
      return builder._run()
    },
    maybeSingle() {
      return builder._run().then((r: any) => ({
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        error: r.error,
      }))
    },

    async _run() {
      try {
        if (table === 'profiles') {
          const { profile } = await request('/api/profile')
          return { data: profile, error: null }
        }
        if (table === 'categories') {
          const { categories } = await request('/api/categories')
          return { data: categories, error: null }
        }
        if (table === 'payment_methods') {
          const { payment_methods } = await request('/api/payment-methods')
          return { data: payment_methods, error: null }
        }
        if (table === 'transactions') {
          const { transactions } = await request('/api/transactions')
          return { data: transactions, error: null }
        }
        return { data: null, error: { message: `Unknown table ${table}` } }
      } catch (e: any) {
        return { data: null, error: { message: e.message } }
      }
    },

    insert(row: any) {
      const promise = (async () => {
        try {
          if (table === 'transactions') {
            const { transaction } = await request('/api/transactions', {
              method: 'POST',
              body: JSON.stringify(row),
            })
            return { data: transaction, error: null }
          }
          if (table === 'profiles') {
            // The signup trigger already created it; nothing to do.
            const { profile } = await request('/api/profile')
            return { data: profile, error: null }
          }
          return { data: null, error: { message: `Insert unsupported for ${table}` } }
        } catch (e: any) {
          return { data: null, error: { message: e.message } }
        }
      })()
      // Support both `await insert(...)` and `insert(...).select().maybeSingle()`
      ;(promise as any).select = () => ({ maybeSingle: () => promise })
      return promise
    },

    update(values: any) {
      return {
        eq: async () => {
          try {
            if (table === 'profiles') {
              const { profile } = await request('/api/profile', {
                method: 'PATCH',
                body: JSON.stringify(values),
              })
              return { data: profile, error: null }
            }
            return { data: null, error: { message: `Update unsupported for ${table}` } }
          } catch (e: any) {
            return { data: null, error: { message: e.message } }
          }
        },
      }
    },
  }
  return builder
}

const previewSupabase = { auth: previewAuth, from }

// ---------------------------------------------------------------------------
// Transactions API — explicit calls rather than the `.from()` shim, because
// server-side filtering, sorting and paging don't fit that shape.
// ---------------------------------------------------------------------------

export interface TransactionFilters {
  month?: string
  category_id?: string
  payment_method_id?: string
  currency?: string
  type?: 'expense' | 'income' | ''
  q?: string
  sort?: 'date_asc' | 'date_desc'
}

const previewTransactionsApi = {
  async list(filters: TransactionFilters = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    return request(`/api/transactions${qs ? `?${qs}` : ''}`) as Promise<{
      transactions: any[]
      total: number
    }>
  },

  async create(row: Record<string, unknown>) {
    return request('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(row),
    }) as Promise<{ transaction: any }>
  },

  async update(id: string, changes: Record<string, unknown>) {
    return request(`/api/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }) as Promise<{ transaction: any }>
  },

  async remove(id: string) {
    return request(`/api/transactions/${id}`, { method: 'DELETE' }) as Promise<{
      ok: boolean
    }>
  },

  async usedCurrencies() {
    return request('/api/transactions/currencies') as Promise<{ currencies: string[] }>
  },

  async usedMonths() {
    return request('/api/transactions/months') as Promise<{ months: string[] }>
  },

  /** Retry conversions for rows saved while rates were unavailable. */
  async backfill(limit = 25) {
    return request('/api/transactions/backfill', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }) as Promise<{ attempted: number; filled: number }>
  },
}

// ---------------------------------------------------------------------------
// Overview — a dedicated aggregate endpoint. Summing the transactions list in
// the client would be wrong: that list is capped, so totals would silently
// under-report for the heaviest users.
// ---------------------------------------------------------------------------

export interface OverviewCategory {
  category_id: string | null
  category_name: string
  total: string
  tx_count: number
}

export interface Overview {
  month: string
  home_currency: string | null
  totals: {
    expense: string
    income: string
    net: string
    /** null when no budget is set — never 0. */
    budget_remaining: string | null
    /** Budget in HOME currency, comparable with the totals above. */
    monthly_budget: string | null
    /** The figure the user actually typed. */
    budget_original: string | null
    /** The currency they typed it in (their local spending currency). */
    budget_currency: string | null
    budget_converted: boolean
    budget_basis_unknown: boolean
  }
  pending_count: number
  approximate_count: number
  transaction_count: number
  categories: OverviewCategory[]
  comparison: {
    prior_month: string
    through_day: number
    prior_through_day: number
    clamped: boolean
    current_expense: string
    prior_expense: string
    change_absolute: string | null
    comparable: boolean
  }
  insights: { id: string; tone: string; text: string }[]
}

const previewOverviewApi = {
  async get(month?: string) {
    const qs = month ? `?month=${encodeURIComponent(month)}` : ''
    return request(`/api/overview${qs}`) as Promise<Overview>
  },
}


// ---------------------------------------------------------------------------
// Backend selection
//
// One place decides which implementation is live. Every page imports the names
// below and is unaware of which backend answered.
// ---------------------------------------------------------------------------

export const auth = isSupabaseConfigured ? supabaseAuth : previewAuth

export const transactionsApi = isSupabaseConfigured
  ? supabaseTransactionsApi
  : previewTransactionsApi

export const overviewApi = isSupabaseConfigured ? supabaseOverviewApi : previewOverviewApi

export const categoriesApi = isSupabaseConfigured
  ? supabaseCategoriesApi
  : { async list() { return request('/api/categories') } }

export const paymentMethodsApi = isSupabaseConfigured
  ? supabasePaymentMethodsApi
  : { async list() { return request('/api/payment-methods') } }

export const profileApi = isSupabaseConfigured
  ? supabaseProfileApi
  : {
      async get() { return request('/api/profile') },
      async update(changes: Record<string, unknown>) {
        return request('/api/profile', { method: 'PATCH', body: JSON.stringify(changes) })
      },
      // The preview signup trigger always creates the row; return the existing one.
      async create() {
        return request('/api/profile')
      },
    }

export const supabase = isSupabaseConfigured
  ? { auth: supabaseAuth, from: () => { throw new Error('use the typed apis') } }
  : previewSupabase
