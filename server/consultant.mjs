/**
 * Budget Consultant — five deterministic rules, at most three emitted.
 *
 * Pure functions over already-aggregated figures: no I/O, no randomness, no LLM.
 * The same inputs always produce the same insights, which is what makes them
 * verifiable.
 *
 * Tone rules, enforced by review not by code: specific, numerical, short, and
 * never moralising. A student's spending category is not a character flaw. Rules
 * suppress themselves on insufficient data rather than hedging.
 *
 * All arithmetic here is on decimal STRINGS via BigInt, never JS floats, because
 * these figures are money.
 */

// ---------- exact decimal helpers (money must not touch float) ----------

function parseDec(v) {
  const s = String(v ?? '0').trim()
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return [0n, 0]
  const [, sign, int, frac = ''] = m
  const value = BigInt(int + frac)
  return [sign === '-' ? -value : value, frac.length]
}

function align(a, b) {
  const [av, as] = parseDec(a)
  const [bv, bs] = parseDec(b)
  const scale = Math.max(as, bs)
  return [av * 10n ** BigInt(scale - as), bv * 10n ** BigInt(scale - bs), scale]
}

function render(value, scale) {
  const neg = value < 0n
  const digits = (neg ? -value : value).toString().padStart(scale + 1, '0')
  let out =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return (neg ? '-' : '') + (out || '0')
}

export function decSub(a, b) {
  const [av, bv, scale] = align(a, b)
  return render(av - bv, scale)
}

export function decCompare(a, b) {
  const [av, bv] = align(a, b)
  return av < bv ? -1 : av > bv ? 1 : 0
}

export function isZero(a) {
  return decCompare(a, '0') === 0
}

/**
 * Percentage of `part` relative to `whole`, to one decimal place, as a string.
 * Returns null when `whole` is zero — a percentage of nothing is not 0%, it is
 * undefined, and rendering it as 0% or ∞ would be a lie.
 */
export function percentOf(part, whole) {
  if (isZero(whole)) return null
  const [pv, wv] = align(part, whole)
  if (wv === 0n) return null
  // One decimal place: scale by 1000 then divide, rounding half away from zero.
  const scaled = (pv * 10000n) / wv
  const rounded = (scaled + (scaled >= 0n ? 5n : -5n)) / 10n
  return render(rounded, 1)
}

/** Signed percentage change from `before` to `after`, or null if undefined. */
export function percentChange(before, after) {
  if (isZero(before)) return null
  return percentOf(decSub(after, before), before)
}

// ---------- rules ----------

/**
 * Build insights. Returns at most `limit` (default 3), highest signal first.
 *
 * @param ctx.month              'YYYY-MM'
 * @param ctx.dayOfMonth         today's day number within the month
 * @param ctx.daysInMonth        length of the month
 * @param ctx.homeCurrency       code, for labelling
 * @param ctx.current            aggregateWindow result for 1..dayOfMonth
 * @param ctx.prior              aggregateWindow result for the equal prior window
 * @param ctx.priorClamped       whether the prior window was clamped
 * @param ctx.priorThroughDay    last day included in the prior window
 * @param ctx.monthlyBudget      decimal string, or null when unset
 * @param ctx.noSpendStreak      consecutive days with no expense, ending today
 */
export function buildInsights(ctx, limit = 3) {
  const rules = [
    ruleBudgetPace,
    ruleCategoryShare,
    ruleCategorySwing,
    ruleOutlier,
    ruleStreak,
  ]

  const out = []
  for (const rule of rules) {
    if (out.length >= limit) break
    const insight = rule(ctx)
    if (insight) out.push(insight)
  }
  return out
}

/**
 * Rule 3 — budget pace projection. Highest signal when it applies, because it is
 * forward-looking and actionable.
 *
 * Gated to day 7 onward: projecting a month from two days of data is noise
 * dressed as insight.
 */
function ruleBudgetPace(ctx) {
  const { monthlyBudget, current, dayOfMonth, daysInMonth, homeCurrency } = ctx
  if (!monthlyBudget || isZero(monthlyBudget)) return null
  if (dayOfMonth < 7) return null
  if (isZero(current.expense)) return null

  // projected = spend_to_date / days_elapsed * days_in_month, in exact decimals.
  const [spend, , scale] = align(current.expense, '0')
  const projectedScaled = (spend * BigInt(daysInMonth)) / BigInt(dayOfMonth)
  const projected = render(projectedScaled, scale)

  const overBy = decSub(projected, monthlyBudget)
  const pct = percentOf(projected, monthlyBudget)

  if (decCompare(projected, monthlyBudget) > 0) {
    return {
      id: 'budget_pace',
      tone: 'warn',
      text:
        `At the current pace you're projected to spend about ` +
        `${money(projected, homeCurrency)} this month, ` +
        `${money(overBy, homeCurrency)} over your ` +
        `${money(monthlyBudget, homeCurrency)} budget` +
        (pct ? ` (${pct}% of it)` : '') +
        `. This is a projection from ${dayOfMonth} days, not a final figure.`,
    }
  }
  return {
    id: 'budget_pace',
    tone: 'ok',
    text:
      `At the current pace you're projected to spend about ` +
      `${money(projected, homeCurrency)} of your ` +
      `${money(monthlyBudget, homeCurrency)} budget` +
      (pct ? ` (${pct}%)` : '') +
      `. This is a projection from ${dayOfMonth} days, not a final figure.`,
  }
}

/** Rule 1 — largest category, its share, and how it compares with last month. */
function ruleCategoryShare(ctx) {
  const { current, prior, homeCurrency } = ctx
  const top = current.categories[0]
  if (!top) return null
  if (isZero(current.expense)) return null

  const share = percentOf(top.total, current.expense)
  if (!share) return null

  let comparison = ''
  const priorMatch = prior.categories.find((c) => c.category_id === top.category_id)
  if (priorMatch && !isZero(priorMatch.total)) {
    const change = percentChange(priorMatch.total, top.total)
    if (change !== null) {
      const dir = decCompare(top.total, priorMatch.total) >= 0 ? 'up' : 'down'
      comparison = ` — ${dir} ${stripSign(change)}% on the same period last month`
    }
  }

  return {
    id: 'category_share',
    tone: 'info',
    text:
      `${top.category_name} is your largest category at ` +
      `${money(top.total, homeCurrency)}, ${share}% of spending${comparison}.`,
  }
}

/** Rule 2 — biggest category mover versus the equal prior period. */
function ruleCategorySwing(ctx) {
  const { current, prior, homeCurrency } = ctx
  if (prior.total_count === 0) return null

  const priorById = new Map(prior.categories.map((c) => [c.category_id, c.total]))
  let best = null

  for (const cat of current.categories) {
    const before = priorById.get(cat.category_id)
    if (before === undefined || isZero(before)) continue // new categories are Rule 1's job
    const delta = decSub(cat.total, before)
    if (isZero(delta)) continue
    const magnitude = stripSign(delta)
    if (!best || decCompare(magnitude, best.magnitude) > 0) {
      best = { cat, before, delta, magnitude }
    }
  }
  if (!best) return null

  const pct = percentChange(best.before, best.cat.total)
  if (pct === null) return null
  // Suppress noise: a swing under 15% is not worth a slot.
  if (decCompare(stripSign(pct), '15') < 0) return null

  const rising = decCompare(best.delta, '0') > 0
  return {
    id: 'category_swing',
    tone: rising ? 'warn' : 'ok',
    text:
      `${best.cat.category_name} changed the most: ` +
      `${rising ? 'up' : 'down'} ${stripSign(pct)}% ` +
      `(${money(stripSign(best.delta), homeCurrency)}) versus the same period ` +
      `last month.`,
  }
}

/**
 * Rule 4 — a category driven by very few transactions, which makes it look like
 * a habit when it is one purchase.
 */
function ruleOutlier(ctx) {
  const { current, homeCurrency } = ctx
  if (isZero(current.expense)) return null

  for (const cat of current.categories) {
    if (cat.tx_count > 3) continue
    const share = percentOf(cat.total, current.expense)
    if (!share) continue
    // Only interesting if a handful of rows dominate the month.
    if (decCompare(share, '25') < 0) continue
    return {
      id: 'outlier',
      tone: 'info',
      text:
        `${cat.category_name} is ${share}% of this month's spending from just ` +
        `${cat.tx_count} transaction${cat.tx_count === 1 ? '' : 's'} ` +
        `(${money(cat.total, homeCurrency)}).`,
    }
  }
  return null
}

/**
 * Rule 5 — consecutive days without an expense.
 *
 * Requires the month to contain some activity. On a month with no transactions
 * at all, "no spending for 31 days in a row" reads as restraint when it actually
 * means no data — precisely the misleading filler the empty state must avoid.
 *
 * Also capped at the days elapsed, and suppressed if the streak covers the whole
 * window, which again means "nothing recorded" rather than a run of frugal days.
 */
function ruleStreak(ctx) {
  const { noSpendStreak, current, dayOfMonth } = ctx
  if (!noSpendStreak || noSpendStreak < 2) return null
  // Nothing recorded this month: there is no streak to report.
  if (current.total_count === 0) return null
  if (isZero(current.expense)) return null
  // A streak covering every elapsed day means no expense rows exist in the
  // window, so it is not a meaningful observation.
  if (noSpendStreak >= dayOfMonth) return null
  return {
    id: 'streak',
    tone: 'ok',
    text: `No spending recorded for the last ${noSpendStreak} days.`,
  }
}

// ---------- formatting ----------

const ZERO_DECIMAL = new Set(['KRW', 'JPY', 'VND', 'IDR', 'CLP', 'ISK', 'HUF'])

function stripSign(v) {
  return String(v).replace(/^-/, '')
}

/**
 * Format a decimal string for display: currency-appropriate decimals, thousands
 * separators, currency code appended. Rounding here is at display only.
 */
export function money(value, currency) {
  const decimals = ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 0 : 2
  const [v, scale] = parseDec(value)
  // Round half away from zero at the target scale, in integer arithmetic.
  let scaled
  if (scale > decimals) {
    const drop = 10n ** BigInt(scale - decimals)
    const half = drop / 2n
    scaled = v >= 0n ? (v + half) / drop : (v - half) / drop
  } else {
    scaled = v * 10n ** BigInt(decimals - scale)
  }
  const neg = scaled < 0n
  const digits = (neg ? -scaled : scaled).toString().padStart(decimals + 1, '0')
  const intPart = digits.slice(0, digits.length - decimals) || '0'
  const fracPart = decimals ? digits.slice(digits.length - decimals) : ''
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${fracPart ? `.${fracPart}` : ''} ${String(currency).toUpperCase()}`
}
