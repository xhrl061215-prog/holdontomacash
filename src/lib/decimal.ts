/**
 * Exact decimal arithmetic for test assertions.
 *
 * Why this exists: asserting `converted == amount * rate` with JS numbers is
 * tautological when the server also used JS floats — both sides carry the same
 * binary-float error, so they agree and the test passes while the stored value
 * is wrong (20 * 1910.38 -> 38207.600000000006).
 *
 * These helpers multiply decimal STRINGS via BigInt, so the expected value is
 * exact and can genuinely disagree with a float-contaminated one.
 */

/** Split a decimal string into scaled BigInt + scale. "19.10" -> [1910n, 2] */
function parseDecimal(input: string | number): [bigint, number] {
  const s = String(input).trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Not a plain decimal string: ${s}. ` +
      `A value in exponential form has already lost exactness.`)
  }
  const negative = s.startsWith('-')
  const body = negative ? s.slice(1) : s
  const [intPart, fracPart = ''] = body.split('.')
  const digits = `${intPart}${fracPart}` || '0'
  const value = BigInt(digits)
  return [negative ? -value : value, fracPart.length]
}

/** Render scaled BigInt back to a decimal string, trailing zeros trimmed. */
function renderDecimal(value: bigint, scale: number): string {
  const negative = value < 0n
  let digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  let out =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  if (out === '' || out === '-') out = '0'
  return negative ? `-${out}` : out
}

/**
 * Exact decimal multiplication. Both inputs must be plain decimal strings
 * (or integers) — this is the point: it refuses inputs that already lost
 * precision.
 */
export function decimalMultiply(a: string | number, b: string | number): string {
  const [av, as] = parseDecimal(a)
  const [bv, bs] = parseDecimal(b)
  return renderDecimal(av * bv, as + bs)
}

/** Exact decimal sum over a list of decimal strings. */
export function decimalSum(values: (string | number)[]): string {
  let maxScale = 0
  const parsed = values.map((v) => {
    const [val, scale] = parseDecimal(v)
    maxScale = Math.max(maxScale, scale)
    return [val, scale] as [bigint, number]
  })
  let total = 0n
  for (const [val, scale] of parsed) {
    total += val * 10n ** BigInt(maxScale - scale)
  }
  return renderDecimal(total, maxScale)
}

/**
 * Compare two decimal strings for exact numeric equality, ignoring
 * representation differences ("38207.60" === "38207.6").
 */
export function decimalEquals(a: string | number, b: string | number): boolean {
  const [av, as] = parseDecimal(a)
  const [bv, bs] = parseDecimal(b)
  const scale = Math.max(as, bs)
  return av * 10n ** BigInt(scale - as) === bv * 10n ** BigInt(scale - bs)
}

/** True when a value carries binary-float dust, e.g. "38207.600000000006". */
export function looksFloatContaminated(value: string | number): boolean {
  const s = String(value)
  // Long runs of 0s or 9s deep in the fraction are the signature of float error.
  return /\.\d*(0{8,}\d|9{8,}\d)/.test(s)
}
