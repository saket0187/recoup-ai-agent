const IST_OFFSET_MINUTES = 330

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const IST_OFFSET_MS = IST_OFFSET_MINUTES * MINUTE_MS

export interface CivilDateTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: number
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b)
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468
  const era = floorDiv(z, 146_097)
  const dayOfEra = z - era * 146_097
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1_460) + floorDiv(dayOfEra, 36_524) - floorDiv(dayOfEra, 146_096),
    365,
  )
  const dayOfYear = dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100))
  const monthPrime = floorDiv(5 * dayOfYear + 2, 153)
  const day = dayOfYear - floorDiv(153 * monthPrime + 2, 5) + 1
  const month = monthPrime + (monthPrime < 10 ? 3 : -9)
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
  return { year, month, day }
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0)
  const era = floorDiv(y, 400)
  const yearOfEra = y - era * 400
  const monthPrime = month > 2 ? month - 3 : month + 9
  const dayOfYear = floorDiv(153 * monthPrime + 2, 5) + day - 1
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

export function toIst(epochMs: number): CivilDateTime {
  const shifted = epochMs + IST_OFFSET_MS
  const days = floorDiv(shifted, DAY_MS)
  const msIntoDay = shifted - days * DAY_MS
  const { year, month, day } = civilFromDays(days)
  return {
    year,
    month,
    day,
    hour: floorDiv(msIntoDay, 3_600_000),
    minute: floorDiv(msIntoDay % 3_600_000, MINUTE_MS),
    second: floorDiv(msIntoDay % MINUTE_MS, 1_000),
    weekday: (((days + 4) % 7) + 7) % 7,
  }
}

export function fromIst(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const days = daysFromCivil(year, month, day)
  return days * DAY_MS + hour * 3_600_000 + minute * MINUTE_MS + second * 1_000 - IST_OFFSET_MS
}

export function istHour(epochMs: number): number {
  return toIst(epochMs).hour
}

export function istDayOfMonth(epochMs: number): number {
  return toIst(epochMs).day
}

export function istWeekday(epochMs: number): number {
  return toIst(epochMs).weekday
}

export function istDateKey(epochMs: number): string {
  const { year, month, day } = toIst(epochMs)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function startOfIstDay(epochMs: number): number {
  const { year, month, day } = toIst(epochMs)
  return fromIst(year, month, day)
}

export function atIst(epochMs: number, hour: number, minute = 0): number {
  const { year, month, day } = toIst(epochMs)
  return fromIst(year, month, day, hour, minute)
}

export function addIstDays(epochMs: number, days: number): number {
  const { year, month, day, hour, minute, second } = toIst(epochMs)
  return fromIst(year, month, day + days, hour, minute, second)
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function isSunday(epochMs: number): boolean {
  return istWeekday(epochMs) === 0
}

export function isSecondOrFourthSaturday(epochMs: number): boolean {
  const { day, weekday } = toIst(epochMs)
  if (weekday !== 6) return false
  const occurrence = Math.ceil(day / 7)
  return occurrence === 2 || occurrence === 4
}

export function isBankingDay(epochMs: number, holidays: ReadonlySet<string> = new Set()): boolean {
  if (isSunday(epochMs)) return false
  if (isSecondOrFourthSaturday(epochMs)) return false
  return !holidays.has(istDateKey(epochMs))
}

export function nextBankingDay(epochMs: number, holidays: ReadonlySet<string> = new Set()): number {
  let cursor = startOfIstDay(addIstDays(epochMs, 1))
  for (let guard = 0; guard < 30; guard++) {
    if (isBankingDay(cursor, holidays)) return cursor
    cursor = startOfIstDay(addIstDays(cursor, 1))
  }
  throw new Error('nextBankingDay: no banking day found within 30 days')
}

export function isSalaryWindow(epochMs: number): boolean {
  const day = istDayOfMonth(epochMs)
  return day >= 1 && day <= 5
}

export function isMonthEnd(epochMs: number): boolean {
  const { year, month, day } = toIst(epochMs)
  return day > daysInMonth(year, month) - 5
}

export function nextSalaryWindow(epochMs: number): number {
  if (isSalaryWindow(epochMs)) return epochMs
  const { year, month } = toIst(epochMs)
  return fromIst(year, month + 1, 1, 10)
}

export function isWithinIstWindow(epochMs: number, startHour: number, endHour: number): boolean {
  const hour = istHour(epochMs)
  return hour >= startHour && hour < endHour
}

export function nextIstWindowStart(epochMs: number, startHour: number, endHour: number): number {
  if (isWithinIstWindow(epochMs, startHour, endHour)) return epochMs
  const hour = istHour(epochMs)
  return hour < startHour ? atIst(epochMs, startHour) : atIst(addIstDays(epochMs, 1), startHour)
}
