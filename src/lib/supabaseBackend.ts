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
import { adaptOverview } from './overviewShape'

/**
 * Config resolution, in priority order:
 *
 *   1. `public/config.js`, read at RUNTIME (window.BUDGET_TRACKER_CONFIG)
 *   2. Vite env vars, baked in at BUILD time
 *
 * The runtime file exists because build-time-only config has a trap: keys added
 * after a deploy are absent from the already-built bundle, so the app fails with
 * "Invalid API key" on a setup that is otherwise correct, and the fix — rebuild —
 * is not discoverable from the error. Editing one small file and reloading needs
 * no build step and no rebuild to take effect.
 *
 * Both paths carry only the anon key, which is designed to be public: RLS denies
 * every row until a policy matches the signed-in caller.
 */
interface RuntimeConfig {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

const runtime: RuntimeConfig =
  (typeof window !== 'undefined'
    ? (window as unknown as { BUDGET_TRACKER_CONFIG?: RuntimeConfig }).BUDGET_TRACKER_CONFIG
    : undefined) ?? {}

/** Placeholder values in the shipped config.js must not count as configured. */
const isPlaceholder = (v?: string) =>
  !v || v.startsWith('PASTE_') || v.includes('your-project') || v.includes('YOUR_')

/**
 * Pick the runtime value only if it is real, else fall back to the build value.
 *
 * A plain `runtime.X || build.X` is wrong: the shipped config.js placeholder is
 * a non-empty string, so it is truthy and shadows a perfectly good build-time
 * env var — the app then claims it is "not connected to a database" while the
 * correct keys sit in the bundle. Emptiness is not the test; being a placeholder
 * is.
 */
const pick = (runtimeValue?: string, buildValue?: string) =>
  isPlaceholder(runtimeValue) ? buildValue : runtimeValue

const rawUrl = pick(runtime.SUPABASE_URL, import.meta.env.VITE_SUPABASE_URL as string | undefined)
const rawAnon = pick(
  runtime.SUPABASE_ANON_KEY,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
)

/**
 * Reduce whatever was pasted to the bare project origin.
 *
 * The Supabase dashboard shows the REST endpoint
 * (`https://<ref>.supabase.co/rest/v1`) next to the anon key, so that is what
 * gets copied — and supabase-js then appends its own paths to it, producing
 * `/rest/v1/auth/v1/signup`. PostgREST answers that with
 * "Invalid path specified in request URL", which names neither the setting nor
 * the fix. Normalising here means either value works.
 *
 * Exported for the regression test.
 */
export function normaliseSupabaseUrl(raw: string): string {
  let v = raw.trim().replace(/\/+$/, '')
  // Strip a copied API path segment: /rest/v1, /auth/v1, /storage/v1, ...
  v = v.replace(/\/(rest|auth|storage|realtime|functions|graphql)\/v\d+$/i, '')
  return v.replace(/\/+$/, '')
}

// Trim: a trailing space or newline pasted from a dashboard is a common and
// otherwise baffling failure.
const URL = isPlaceholder(rawUrl) ? undefined : normaliseSupabaseUrl(rawUrl!)
const ANON = isPlaceholder(rawAnon) ? undefined : rawAnon!.trim()

/** True when hosted Supabase is configured. Read by supabaseClient.ts. */
export const isSupabaseConfigured = Boolean(URL && ANON)

/** Where the config came from, so the UI can say rather than imply. */
export const configSource: 'runtime' | 'build' | 'none' = !isSupabaseConfigured
  ? 'none'
  : !isPlaceholder(runtime.SUPABASE_URL)
    ? 'runtime'
    : 'build'

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

  /**
   * Create this user's profile row if the signup trigger did not.
   * Separate from update(): an UPDATE matching no row is not an insert, so
   * reusing update() here would "succeed" while leaving the user profile-less.
   */
  async create() {
    const user = await requireUser()
    const { data, error } = await getClient()
      .from('profiles').insert({ id: user.id, onboarded: false }).select().single()
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
    const m = month ?? new Date().toISOString().slice(0, 7)
    // Aggregation stays in SQL so it covers every row, not the 500-row page.
    const { data, error } = await getClient().rpc('overview_for_month', { p_month: m })
    if (error) throw new Error(error.message)
    return adaptOverview(data, m, null)
  },
}

export type { Overview, OverviewCategory, TransactionFilters }
