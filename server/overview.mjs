/**
 * Overview aggregation — Phase 3.
 *
 * Every sum happens in Postgres as `numeric`. Summing in JS would reintroduce
 * binary-float error, and summing a capped page of rows in the client would
 * silently under-report for exactly the heaviest users.
 *
 * Month bucketing uses `to_char(transaction_date, 'YYYY-MM')` string comparison,
 * never a JS Date, so a transaction never lands in the wrong month for a user
 * outside UTC.
 *
 * Rows with `converted_amount IS NULL` are EXCLUDED from totals and counted
 * separately. Treating them as zero would make a total quietly wrong.
 */

/** Days in a given YYYY-MM. */
export function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Shift a YYYY-MM back by one month. */
export function previousMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}`
}

/**
 * Equal-period comparison bounds.
 *
 * Compares 1st..dayOfMonth of the current month against 1st..the same day of the
 * prior month. If the prior month is shorter (e.g. comparing 31 March against
 * February), the range clamps to its last day and `clamped` reports it, so the
 * UI can say so rather than implying an equal window.
 */
export function equalPeriodBounds(currentMonth, dayOfMonth) {
  const prior = previousMonth(currentMonth)
  const priorLength = daysInMonth(prior)
  const clampedDay = Math.min(dayOfMonth, priorLength)
  return {
    prior,
    priorThroughDay: clampedDay,
    clamped: clampedDay !== dayOfMonth,
    currentThroughDay: dayOfMonth,
  }
}

/** Inclusive date string bound: the Nth day of a YYYY-MM. */
export function dayBound(monthStr, day) {
  return `${monthStr}-${String(day).padStart(2, '0')}`
}

/**
 * Aggregate one window: totals by type, per-category expense breakdown, and
 * pending/approximate counts.
 *
 * `runAsUser` runs a query with RLS enforced. All arithmetic is SQL numeric;
 * values come back as strings and stay strings.
 */
export async function aggregateWindow(runAsUser, { fromDate, toDate }) {
  const [totals, categories, flags] = await Promise.all([
    runAsUser(
      `select
         coalesce(sum(converted_amount) filter (where transaction_type = 'expense'), 0)::text as expense,
         coalesce(sum(converted_amount) filter (where transaction_type = 'income'), 0)::text as income,
         count(*) filter (where transaction_type = 'expense' and converted_amount is not null) as expense_rows,
         count(*) filter (where transaction_type = 'income' and converted_amount is not null) as income_rows
       from public.transactions
       where transaction_date >= $1 and transaction_date <= $2
         and converted_amount is not null`,
      [fromDate, toDate],
    ),
    runAsUser(
      `select
         t.category_id,
         coalesce(c.name, 'Uncategorised') as category_name,
         sum(t.converted_amount)::text as total,
         count(*)::int as tx_count
       from public.transactions t
       left join public.categories c on c.id = t.category_id
       where t.transaction_date >= $1 and t.transaction_date <= $2
         and t.transaction_type = 'expense'
         and t.converted_amount is not null
       group by t.category_id, c.name
       order by sum(t.converted_amount) desc`,
      [fromDate, toDate],
    ),
    runAsUser(
      `select
         count(*) filter (where converted_amount is null)::int as pending_count,
         count(*) filter (where rate_is_approximate)::int as approximate_count,
         count(*)::int as total_count
       from public.transactions
       where transaction_date >= $1 and transaction_date <= $2`,
      [fromDate, toDate],
    ),
  ])

  return {
    expense: totals[0]?.expense ?? '0',
    income: totals[0]?.income ?? '0',
    expense_rows: Number(totals[0]?.expense_rows ?? 0),
    income_rows: Number(totals[0]?.income_rows ?? 0),
    categories,
    pending_count: flags[0]?.pending_count ?? 0,
    approximate_count: flags[0]?.approximate_count ?? 0,
    total_count: flags[0]?.total_count ?? 0,
  }
}
