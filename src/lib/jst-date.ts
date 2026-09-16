function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** A calendar date in the product's Japanese timezone. */
export function tokyoToday(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** Subtract calendar months while clamping the day to the target month's end. */
export function subtractCalendarMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const zeroBasedMonth = year * 12 + month - 1 - months
  const targetYear = Math.floor(zeroBasedMonth / 12)
  const targetMonth = zeroBasedMonth % 12 + 1
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth))
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`
}

export function assetHistoryRange(now = new Date()) {
  const to = tokyoToday(now)
  return { from: subtractCalendarMonths(to, 5), to }
}
