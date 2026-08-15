/**
 * Currency conversion service.
 *
 * Rate source chain:
 *   1. Frankfurter (api.frankfurter.dev) — ECB data, ~30 currencies, supports
 *      historical dates. Authoritative when it covers the pair.
 *   2. open.er-api.com — 160+ currencies but LATEST rates only. Used when
 *      Frankfurter lacks the pair (e.g. VND) or is unreachable.
 *
 * Weekend / holiday resolution (documented decision):
 *   ECB publishes on TARGET weekdays only. Frankfurter itself resolves a
 *   non-publication date to the nearest PRIOR publication and reports the date
 *   it actually used in its `date` field. We adopt that behaviour rather than
 *   inventing our own, and we persist the returned date as `rate_date` so a row
 *   always records which day's rate it used. Deterministic and auditable.
 *
 * Approximation flag:
 *   A rate is exact when it came from Frankfurter for the requested date (or
 *   that date's nearest prior publication). It is APPROXIMATE when open.er-api
 *   supplied a current rate for a PAST transaction date, because that is not
 *   the rate that applied on the day. `rate_is_approximate` records this so the
 *   UI can label it instead of presenting an approximation as exact.
 *
 * Precision:
 *   Rates and converted amounts are stored at full precision. Rounding happens
 *   at display only (see roundForDisplay / currency decimals).
 */

const FRANKFURTER = 'https://api.frankfurter.dev/v1'
const ER_API = 'https://open.er-api.com/v6/latest'

const LATEST_TTL_MS = 6 * 60 * 60 * 1000 // 6h for current rates
const FETCH_TIMEOUT_MS = 8000

/** Currencies with no minor unit — display with 0 decimals. */
const ZERO_DECIMAL = new Set(['KRW', 'JPY', 'VND', 'IDR', 'CLP', 'ISK', 'HUF'])

export function decimalsFor(currency) {
  return ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 0 : 2
}

/**
 * Banker's rounding (half to even) — avoids the upward bias of half-up when
 * summing many rows.
 */
export function bankersRound(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  const factor = 10 ** decimals
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const EPS = 1e-9
  let rounded
  if (Math.abs(diff - 0.5) < EPS) {
    rounded = floor % 2 === 0 ? floor : floor + 1
  } else {
    rounded = Math.round(scaled)
  }
  return rounded / factor
}

/** Round an amount for DISPLAY in a given currency. Storage keeps full precision. */
export function roundForDisplay(amount, currency) {
  return bankersRound(amount, decimalsFor(currency))
}

// ---------------- rate cache (in-process) ----------------
// Key: `${from}->${to}@${date}`. Past dates never expire (ECB history is
// immutable); 'latest' expires after 6h.
const cache = new Map()

const cacheKey = (from, to, date) => `${from}->${to}@${date}`

function cacheGet(from, to, date) {
  const hit = cache.get(cacheKey(from, to, date))
  if (!hit) return null
  if (hit.isLatest && Date.now() - hit.storedAt > LATEST_TTL_MS) {
    cache.delete(cacheKey(from, to, date))
    return null
  }
  return hit.value
}

function cacheSet(from, to, date, value, isLatest) {
  cache.set(cacheKey(from, to, date), { value, isLatest, storedAt: Date.now() })
}

export function _clearRateCache() {
  cache.clear()
}

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null // network error, timeout, or bad JSON — caller falls through
  } finally {
    clearTimeout(timer)
  }
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Resolve an exchange rate for `from`->`to` as of `date` (YYYY-MM-DD).
 *
 * Returns:
 *   { rate, rate_date, source, approximate }  on success
 *   null                                       when no source could supply one
 *
 * Never throws — a rate failure must not block a save.
 */
export async function getRate(from, to, date) {
  const base = String(from).toUpperCase()
  const quote = String(to).toUpperCase()

  // Same currency: no API call, exact by definition.
  if (base === quote) {
    return { rate: 1, rate_date: date, source: 'identity', approximate: false }
  }

  const today = todayStr()
  const isFuture = date > today
  // A future-dated transaction can only use the latest known rate.
  const effectiveDate = isFuture ? today : date
  const wantsLatest = effectiveDate === today

  const cached = cacheGet(base, quote, wantsLatest ? 'latest' : effectiveDate)
  if (cached) return cached

  // --- 1. Frankfurter (handles both historical and latest) ---
  const fUrl = wantsLatest
    ? `${FRANKFURTER}/latest?base=${base}&symbols=${quote}`
    : `${FRANKFURTER}/${effectiveDate}?base=${base}&symbols=${quote}`

  const f = await fetchJson(fUrl)
  const fRate = f?.rates?.[quote]
  if (typeof fRate === 'number' && Number.isFinite(fRate) && fRate > 0) {
    const result = {
      rate: fRate,
      // Frankfurter reports the publication date it actually used, which is how
      // weekends/holidays resolve to the nearest prior weekday.
      rate_date: f.date ?? effectiveDate,
      source: 'frankfurter',
      approximate: false,
    }
    cacheSet(base, quote, wantsLatest ? 'latest' : effectiveDate, result, wantsLatest)
    return result
  }

  // --- 2. open.er-api fallback: current rates only ---
  const e = await fetchJson(`${ER_API}/${base}`)
  const eRate = e?.rates?.[quote]
  if (e?.result === 'success' && typeof eRate === 'number' && Number.isFinite(eRate) && eRate > 0) {
    const result = {
      rate: eRate,
      rate_date: today,
      source: 'er-api',
      // Only exact if the transaction is for today; a current rate applied to a
      // past date is an approximation and must be labelled as such.
      approximate: effectiveDate !== today,
    }
    // Cached under 'latest' semantics — it IS a latest rate whatever we needed.
    cacheSet(base, quote, 'latest', result, true)
    return result
  }

  // --- 3. Nothing available. Caller saves with nulls and backfills. ---
  return null
}

/**
 * Rates arrive from JSON as IEEE-754 doubles, which is unavoidable. Render one
 * to its shortest exact decimal string so Postgres can parse it as `numeric`
 * without a second rounding step.
 *
 * `String(double)` already yields the shortest representation that round-trips,
 * so it is exactly the decimal Postgres should receive. Exponential notation
 * (tiny rates like 2.8e-5) is expanded, since numeric accepts plain decimals.
 */
export function rateToNumericString(rate) {
  const s = String(rate)
  if (!/e/i.test(s)) return s
  // Expand exponential form without going back through float arithmetic.
  const [mantissa, expPart] = s.split(/e/i)
  const exp = Number(expPart)
  const negative = mantissa.startsWith('-')
  const digits = mantissa.replace(/^-/, '').replace('.', '')
  const dotIndex = mantissa.replace(/^-/, '').indexOf('.')
  const intLen = dotIndex === -1 ? mantissa.replace(/^-/, '').length : dotIndex
  let pointPos = intLen + exp
  let out
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length)
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  }
  return negative ? `-${out}` : out
}

/**
 * Resolve the conversion for a transaction write.
 *
 * IMPORTANT — no JS arithmetic on the money path. `amount * rate` in binary
 * floating point produces values like 38207.600000000006, and since
 * `converted_amount` is now unscaled `numeric`, Postgres faithfully stores that
 * error instead of rounding it away. Per-row dust then compounds when Overview
 * sums the column.
 *
 * So this function does NOT multiply. It returns the rate as an exact decimal
 * string and leaves the multiplication to Postgres, which does it in `numeric`.
 * Callers must insert `converted_amount` as the SQL expression
 * `amount * exchange_rate` computed in SQL.
 *
 * `homeCurrency` must be the profile's home_currency SNAPSHOTTED at write time,
 * so later profile changes never mutate historical rows.
 *
 * Always resolves — on rate failure the conversion fields are null and the row
 * is saved anyway ("rate pending"), then backfilled.
 */
export async function buildConversion(amount, currency, transactionDate, homeCurrency) {
  const resolved = await getRate(currency, homeCurrency, transactionDate)

  if (!resolved) {
    return {
      exchange_rate: null,
      converted_currency: homeCurrency, // snapshot the intent even when pending
      rate_date: null,
      rate_source: null,
      rate_is_approximate: false,
    }
  }

  return {
    // Exact decimal string — Postgres parses this as numeric, no float step.
    exchange_rate: rateToNumericString(resolved.rate),
    converted_currency: homeCurrency,
    rate_date: resolved.rate_date,
    rate_source: resolved.source,
    rate_is_approximate: resolved.approximate,
  }
}
