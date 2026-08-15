/**
 * Verifies runtime configuration — the path that lets someone connect the app to
 * their database by editing one file, with no rebuild.
 *
 * This exists because build-time-only config has a trap that is hard to diagnose
 * from the symptom: keys added after a deploy are missing from the already-built
 * bundle, so the app reports "Invalid API key" while the dashboard shows a correct
 * setup, and the fix (rebuild) is not discoverable from the error.
 *
 * The risks in the runtime path are specific, so they are asserted specifically:
 *   - shipped PLACEHOLDER values must not count as configured, or the app tries to
 *     reach a fake URL and reports a confusing network error instead of "not set up"
 *   - a pasted value with a trailing space or newline must still work
 *   - runtime config must WIN over build-time, so editing the file has an effect
 *   - config.js must be served unhashed, or it cannot be edited after deploy
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Imported as raw text rather than read from disk, so this test needs no Node
// type definitions and stays inside the app's own tsconfig.
import shippedConfigJs from '../../public/config.js?raw'
import indexHtml from '../../index.html?raw'

const REAL_URL = 'https://abcdefghijklmnop.supabase.co'
const REAL_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PLACEHOLDER_FOR_TEST_ONLY.signature'

/** Load the module fresh with a given window config + env. */
async function loadWith(
  runtime: Record<string, string> | undefined,
  env: Record<string, string> = {},
) {
  vi.resetModules()
  if (runtime === undefined) {
    delete (globalThis as any).window.BUDGET_TRACKER_CONFIG
  } else {
    ;(globalThis as any).window.BUDGET_TRACKER_CONFIG = runtime
  }
  vi.stubEnv('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL ?? '')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY ?? '')
  return import('../lib/supabaseBackend')
}

beforeEach(() => {
  if (typeof (globalThis as any).window === 'undefined') (globalThis as any).window = {}
})
afterEach(() => {
  delete (globalThis as any).window.BUDGET_TRACKER_CONFIG
  vi.unstubAllEnvs()
})

describe('placeholder values must not count as configured', () => {
  // The shipped config.js contains placeholders. If those were treated as real,
  // the app would attempt to reach a nonexistent host and surface a network error
  // instead of "not configured yet" — the difference between a confusing failure
  // and an accurate one.
  it('the values actually shipped in public/config.js are rejected', async () => {
    const shipped = shippedConfigJs
    const url = shipped.match(/SUPABASE_URL:\s*'([^']*)'/)?.[1]
    const key = shipped.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/)?.[1]
    expect(url, 'config.js must define SUPABASE_URL').toBeTruthy()
    expect(key, 'config.js must define SUPABASE_ANON_KEY').toBeTruthy()

    const mod = await loadWith({ SUPABASE_URL: url!, SUPABASE_ANON_KEY: key! })
    expect(mod.isSupabaseConfigured).toBe(false)
    expect(mod.configSource).toBe('none')
  })

  it.each([
    'PASTE_YOUR_PROJECT_URL_HERE',
    'PASTE_YOUR_ANON_KEY_HERE',
    'https://your-project-ref.supabase.co',
    'YOUR_KEY_HERE',
    '',
  ])('rejects placeholder %s', async (v) => {
    const mod = await loadWith({ SUPABASE_URL: v, SUPABASE_ANON_KEY: v })
    expect(mod.isSupabaseConfigured).toBe(false)
  })

  it('a half-filled config is not configured', async () => {
    const mod = await loadWith({
      SUPABASE_URL: REAL_URL,
      SUPABASE_ANON_KEY: 'PASTE_YOUR_ANON_KEY_HERE',
    })
    expect(mod.isSupabaseConfigured).toBe(false)
  })
})

describe('real values are accepted, and forgiving of paste errors', () => {
  it('accepts a correctly filled runtime config', async () => {
    const mod = await loadWith({ SUPABASE_URL: REAL_URL, SUPABASE_ANON_KEY: REAL_KEY })
    expect(mod.isSupabaseConfigured).toBe(true)
    expect(mod.configSource).toBe('runtime')
  })

  it('tolerates trailing whitespace and newlines from a dashboard copy', async () => {
    // Copying from a web dashboard commonly picks up a trailing space or newline.
    // Failing on that would produce an "Invalid API key" with no visible cause.
    const mod = await loadWith({
      SUPABASE_URL: `  ${REAL_URL}\n`,
      SUPABASE_ANON_KEY: ` ${REAL_KEY}  `,
    })
    expect(mod.isSupabaseConfigured).toBe(true)
  })
})

describe('runtime config takes priority over the build-time bundle', () => {
  it('runtime wins, so editing config.js actually has an effect', async () => {
    // If build-time won, editing the file after deploy would silently do nothing —
    // the exact trap this path exists to remove.
    const mod = await loadWith(
      { SUPABASE_URL: REAL_URL, SUPABASE_ANON_KEY: REAL_KEY },
      {
        VITE_SUPABASE_URL: 'https://stale-build-value.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'stale-build-key',
      },
    )
    expect(mod.configSource).toBe('runtime')
  })

  it('falls back to build-time env when no runtime file is present', async () => {
    const mod = await loadWith(undefined, {
      VITE_SUPABASE_URL: REAL_URL,
      VITE_SUPABASE_ANON_KEY: REAL_KEY,
    })
    expect(mod.isSupabaseConfigured).toBe(true)
    expect(mod.configSource).toBe('build')
  })

  it('the SHIPPED placeholder config.js does not shadow real build-time keys', async () => {
    // Regression, found on Lily's live deploy: public/config.js always ships with
    // placeholder values, and a plain `runtime || build` treats those non-empty
    // strings as truthy. The app then rendered "not yet connected to a database"
    // while the correct keys were sitting in the bundle. The earlier tests missed
    // it because they modelled "no runtime file", which is never what deploys.
    const mod = await loadWith(
      { SUPABASE_URL: 'PASTE_YOUR_PROJECT_URL_HERE', SUPABASE_ANON_KEY: 'PASTE_YOUR_ANON_KEY_HERE' },
      { VITE_SUPABASE_URL: REAL_URL, VITE_SUPABASE_ANON_KEY: REAL_KEY },
    )
    expect(mod.isSupabaseConfigured).toBe(true)
    expect(mod.configSource).toBe('build')
  })

  it('a half-filled config.js still falls back rather than half-configuring', async () => {
    const mod = await loadWith(
      { SUPABASE_URL: REAL_URL, SUPABASE_ANON_KEY: 'PASTE_YOUR_ANON_KEY_HERE' },
      { VITE_SUPABASE_URL: REAL_URL, VITE_SUPABASE_ANON_KEY: REAL_KEY },
    )
    expect(mod.isSupabaseConfigured).toBe(true)
  })

  it('with neither source, the app reports unconfigured rather than guessing', async () => {
    const mod = await loadWith(undefined, {})
    expect(mod.isSupabaseConfigured).toBe(false)
    expect(mod.configSource).toBe('none')
  })
})

describe('config.js stays editable after deployment', () => {
  it('is loaded by index.html before the app bundle', () => {
    const html = indexHtml
    expect(html).toContain('/config.js')
    // Must come before the module script, or the app reads it too late.
    expect(html.indexOf('/config.js')).toBeLessThan(html.indexOf('/src/main.tsx'))
  })

  it('carries no real credentials in the repository', () => {
    const shipped = shippedConfigJs
    // A real Supabase project URL or JWT must never be committed here.
    expect(shipped).not.toMatch(/https:\/\/[a-z]{20}\.supabase\.co/)
    expect(shipped).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/)
  })

  it('warns against the service_role key', () => {
    // The one irreversible mistake available at this step.
    const shipped = shippedConfigJs
    expect(shipped).toMatch(/service_role/)
    expect(shipped).toMatch(/anon public/)
  })
})
