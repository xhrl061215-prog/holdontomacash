/** Today's date as YYYY-MM-DD in the user's local timezone (never UTC —
 *  avoids the off-by-one where a late-evening entry lands on tomorrow). */
export function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
