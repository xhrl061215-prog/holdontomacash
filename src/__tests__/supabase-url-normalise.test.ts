/**
 * Regression: Lily's first live deploy failed sign-up with
 * "Invalid path specified in request URL" because the Supabase dashboard shows
 * the REST endpoint (.../rest/v1) beside the anon key, so that is what got
 * pasted into VITE_SUPABASE_URL. supabase-js appended its own paths to it and
 * hit /rest/v1/auth/v1/signup.
 *
 * Reproduced against the real project before fixing: the /rest/v1 form returned
 * PGRST125 "Invalid path specified in request URL"; the bare origin signed up.
 */
import { describe, expect, it } from 'vitest'
import { normaliseSupabaseUrl } from '../lib/supabaseBackend'

const ORIGIN = 'https://examplerefabcdefghij.supabase.co'

describe('normaliseSupabaseUrl', () => {
  it('leaves a correct project URL alone', () => {
    expect(normaliseSupabaseUrl(ORIGIN)).toBe(ORIGIN)
  })

  it.each([
    `${ORIGIN}/rest/v1`,
    `${ORIGIN}/rest/v1/`,
    `${ORIGIN}/auth/v1`,
    `${ORIGIN}/storage/v1`,
    `${ORIGIN}/functions/v1`,
    `${ORIGIN}/realtime/v1`,
  ])('strips a pasted API path: %s', (input) => {
    expect(normaliseSupabaseUrl(input)).toBe(ORIGIN)
  })

  it('strips trailing slashes and surrounding whitespace', () => {
    expect(normaliseSupabaseUrl(`  ${ORIGIN}//  \n`)).toBe(ORIGIN)
  })

  it('does not eat a legitimate path-like project host', () => {
    expect(normaliseSupabaseUrl('https://db.example.com/v1')).toBe('https://db.example.com/v1')
  })
})
