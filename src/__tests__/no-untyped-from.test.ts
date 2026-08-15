/**
 * Regression: the hosted build rendered a BLANK page after sign-in.
 *
 * `supabaseClient.ts` exports a `supabase` object whose shape differs per
 * backend. The preview one has a working `.from()` shim; the hosted one is
 * `from: () => { throw new Error('use the typed apis') }`. Several pages and
 * AuthContext called `supabase.from(...)` directly, so on the hosted backend
 * they threw during render — React unmounted the tree and the user saw nothing.
 *
 * Reproduced in a real browser against the live deployment before fixing:
 * "[PAGEERROR] use the typed apis" thrown from AuthContext's profile load, with
 * root innerHTML length 0.
 *
 * Why a source-level test: no behavioural test caught this because the suite
 * runs on the PREVIEW backend, where `.from()` works — and phase1's mock even
 * supplied a working `.from()` of its own. The difference between the backends
 * was invisible to the tests, so the guard asserts on the source instead.
 *
 * Uses Vite's raw glob rather than node:fs so it typechecks under the app's
 * tsconfig (types: ["vite/client"]) without granting app code node globals.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** The two backend adapters are the only files allowed to know about `.from()`. */
const ALLOWED = /lib\/(supabaseClient|supabaseBackend)\.ts$/

describe('no page calls the untyped .from() shim', () => {
  const files = Object.entries(sources).filter(
    ([path]) => !ALLOWED.test(path) && !path.includes('__tests__'),
  )

  it('finds source files to check (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files)('%s uses the typed APIs, not supabase.from()', (_path, src) => {
    expect(src).not.toMatch(/\bsupabase\s*\n?\s*\.\s*from\s*\(/)
  })

  it('the hosted shim still throws, so a regression is loud not silent', () => {
    const client = sources['../lib/supabaseClient.ts']
    expect(client).toContain('use the typed apis')
  })
})
