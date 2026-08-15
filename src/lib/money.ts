/**
 * Display-side money formatting.
 *
 * Storage keeps full precision; rounding happens here, at the point of display.
 * Banker's rounding (half to even) avoids the upward bias half-up introduces
 * when totalling many rows.
 */

/** Currencies with no minor unit — ₩27,431 never ₩27,431.00 */
const ZERO_DECIMAL = new Set(['KRW', 'JPY', 'VND', 'IDR', 'CLP', 'ISK', 'HUF'])

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL.has((currency ?? '').toUpperCase()) ? 0 : 2
}

/** Banker's rounding: halves go to the nearest even digit. */
export function bankersRound(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const EPS = 1e-9
  let rounded: number
  if (Math.abs(diff - 0.5) < EPS) {
    rounded = floor % 2 === 0 ? floor : floor + 1
  } else {
    rounded = Math.round(scaled)
  }
  return rounded / factor
}

/**
 * Format an amount in its currency's conventional precision.
 * Returns an em dash for null so a pending conversion reads as absent, not zero.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string,
): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return '—'
  const decimals = decimalsFor(currency)
  return bankersRound(n, decimals).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** Signed display for a transaction: income reads +, expense reads bare. */
export function formatSigned(
  amount: number | string | null | undefined,
  currency: string,
  type: 'expense' | 'income',
): string {
  const formatted = formatMoney(amount, currency)
  if (formatted === '—') return formatted
  return type === 'income' ? `+${formatted}` : formatted
}

/**
 * Exchange rates need more precision than money — a JPY→GBP rate is 0.00465,
 * which would round to 0.00 at 2dp.
 */
export function formatRate(rate: number | string | null | undefined): string {
  if (rate === null || rate === undefined || rate === '') return '—'
  const n = typeof rate === 'string' ? parseFloat(rate) : rate
  if (!Number.isFinite(n)) return '—'
  if (n === 1) return '1'
  if (n < 0.01) return n.toPrecision(3)
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/**
 * Validate an amount the same way the server does, so the user gets inline
 * feedback instead of a round-trip error. Returns an error message, or null.
 *
 * Deliberately mirrors server/index.mjs amountToNumericString — including the
 * order of checks, so "0.00" reports "greater than 0" rather than a misleading
 * complaint about decimals.
 */
export function validateAmount(input: string, currency: string): string | null {
  const s = input.trim()
  if (s === '') return 'Enter an amount.'
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return 'Amount must be a positive number.'
  }
  if (/^0+(\.0*)?$/.test(s)) {
    return 'Amount must be greater than 0.'
  }
  const maxDecimals = decimalsFor(currency)
  const [, fraction = ''] = s.split('.')
  if (fraction.length > maxDecimals) {
    const code = (currency || '').toUpperCase()
    return maxDecimals === 0
      ? `${code} has no decimal unit — enter a whole number.`
      : `${code} amounts support at most ${maxDecimals} decimal places.`
  }
  return null
}
