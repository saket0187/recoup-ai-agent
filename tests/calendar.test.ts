import { describe, expect, it } from 'vitest'

import {
  addIstDays,
  atIst,
  daysInMonth,
  fromIst,
  isBankingDay,
  isMonthEnd,
  isSalaryWindow,
  isSecondOrFourthSaturday,
  isSunday,
  isWithinIstWindow,
  istDateKey,
  istHour,
  nextBankingDay,
  nextIstWindowStart,
  nextSalaryWindow,
  startOfIstDay,
  toIst,
} from '../src/core/calendar'

const noon = (y: number, m: number, d: number): number => fromIst(y, m, d, 12)

describe('IST conversion', () => {
  it('anchors the Unix epoch at 05:30 IST', () => {
    expect(fromIst(1970, 1, 1, 5, 30)).toBe(0)
    expect(toIst(0)).toMatchObject({ year: 1970, month: 1, day: 1, hour: 5, minute: 30 })
  })

  it('round-trips an arbitrary instant', () => {
    const ms = fromIst(2026, 9, 15, 14, 37, 12)
    expect(toIst(ms)).toMatchObject({
      year: 2026,
      month: 9,
      day: 15,
      hour: 14,
      minute: 37,
      second: 12,
    })
  })

  it('crosses the IST day boundary correctly', () => {
    const lateUtc = fromIst(2026, 9, 15, 0, 30)
    expect(istDateKey(lateUtc)).toBe('2026-09-15')
    expect(istDateKey(lateUtc - 60 * 60_000)).toBe('2026-09-14')
  })

  it('handles dates before the epoch', () => {
    expect(istDateKey(fromIst(1965, 3, 4, 12))).toBe('1965-03-04')
    expect(toIst(fromIst(1965, 3, 4, 12))).toMatchObject({ year: 1965, month: 3, day: 4 })
  })

  it('handles leap days', () => {
    expect(istDateKey(noon(2024, 2, 29))).toBe('2024-02-29')
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
  })

  it('computes the weekday', () => {
    expect(toIst(noon(2026, 9, 1)).weekday).toBe(2)
    expect(toIst(noon(2026, 1, 1)).weekday).toBe(4)
    expect(isSunday(noon(2026, 9, 13))).toBe(true)
    expect(isSunday(noon(2026, 9, 14))).toBe(false)
  })

  it('normalises an out-of-range day into the next month', () => {
    expect(istDateKey(fromIst(2026, 9, 31))).toBe('2026-10-01')
    expect(istDateKey(fromIst(2026, 12, 32))).toBe('2027-01-01')
  })
})

describe('day arithmetic', () => {
  it('adds days while preserving the time of day', () => {
    const start = fromIst(2026, 9, 28, 14, 30)
    const later = addIstDays(start, 5)
    expect(istDateKey(later)).toBe('2026-10-03')
    expect(istHour(later)).toBe(14)
  })

  it('truncates to the start of the IST day', () => {
    const ms = startOfIstDay(fromIst(2026, 9, 15, 23, 59))
    expect(toIst(ms)).toMatchObject({ day: 15, hour: 0, minute: 0 })
  })

  it('sets a specific IST hour on the same day', () => {
    const ms = atIst(fromIst(2026, 9, 15, 23, 30), 9)
    expect(toIst(ms)).toMatchObject({ day: 15, hour: 9, minute: 0 })
  })
})

describe('banking days', () => {
  it('excludes Sundays', () => {
    expect(isBankingDay(noon(2026, 9, 13))).toBe(false)
  })

  it('excludes the second and fourth Saturday, as Indian banks do', () => {
    expect(isSecondOrFourthSaturday(noon(2026, 9, 12))).toBe(true)
    expect(isSecondOrFourthSaturday(noon(2026, 9, 26))).toBe(true)
    expect(isBankingDay(noon(2026, 9, 12))).toBe(false)
    expect(isBankingDay(noon(2026, 9, 26))).toBe(false)
  })

  it('includes the first, third and fifth Saturday', () => {
    expect(isBankingDay(noon(2026, 9, 5))).toBe(true)
    expect(isBankingDay(noon(2026, 9, 19))).toBe(true)
  })

  it('excludes a declared holiday', () => {
    const holidays = new Set(['2026-09-15'])
    expect(isBankingDay(noon(2026, 9, 15))).toBe(true)
    expect(isBankingDay(noon(2026, 9, 15), holidays)).toBe(false)
  })

  it('finds the next banking day across a weekend', () => {
    const friday = noon(2026, 9, 11)
    expect(istDateKey(nextBankingDay(friday))).toBe('2026-09-14')
  })

  it('skips a holiday that abuts a weekend', () => {
    const holidays = new Set(['2026-09-14', '2026-09-15'])
    expect(istDateKey(nextBankingDay(noon(2026, 9, 11), holidays))).toBe('2026-09-16')
  })

  it('always returns the start of the day', () => {
    expect(toIst(nextBankingDay(fromIst(2026, 9, 11, 23, 45)))).toMatchObject({
      hour: 0,
      minute: 0,
    })
  })
})

describe('salary and month-end windows', () => {
  it('treats the first five days as the salary window', () => {
    for (const day of [1, 2, 3, 4, 5]) {
      expect(isSalaryWindow(noon(2026, 9, day))).toBe(true)
    }
    expect(isSalaryWindow(noon(2026, 9, 6))).toBe(false)
  })

  it('treats the last five days as month end', () => {
    expect(isMonthEnd(noon(2026, 9, 26))).toBe(true)
    expect(isMonthEnd(noon(2026, 9, 30))).toBe(true)
    expect(isMonthEnd(noon(2026, 9, 25))).toBe(false)
    expect(isMonthEnd(noon(2026, 2, 24))).toBe(true)
  })

  it('returns the current instant when already in the salary window', () => {
    const inWindow = noon(2026, 9, 3)
    expect(nextSalaryWindow(inWindow)).toBe(inWindow)
  })

  it('rolls to the first of next month otherwise', () => {
    expect(istDateKey(nextSalaryWindow(noon(2026, 9, 20)))).toBe('2026-10-01')
    expect(istDateKey(nextSalaryWindow(noon(2026, 12, 20)))).toBe('2027-01-01')
  })
})

describe('contact windows', () => {
  it('knows whether an instant is inside quiet hours', () => {
    expect(isWithinIstWindow(fromIst(2026, 9, 15, 9), 9, 20)).toBe(true)
    expect(isWithinIstWindow(fromIst(2026, 9, 15, 19, 59), 9, 20)).toBe(true)
    expect(isWithinIstWindow(fromIst(2026, 9, 15, 20), 9, 20)).toBe(false)
    expect(isWithinIstWindow(fromIst(2026, 9, 15, 8, 59), 9, 20)).toBe(false)
  })

  it('defers a pre-dawn instant to the same morning', () => {
    const deferred = nextIstWindowStart(fromIst(2026, 9, 15, 3), 9, 20)
    expect(toIst(deferred)).toMatchObject({ day: 15, hour: 9 })
  })

  it('defers a late-night instant to the next morning, not the same one', () => {
    const deferred = nextIstWindowStart(fromIst(2026, 9, 15, 23), 9, 20)
    expect(toIst(deferred)).toMatchObject({ day: 16, hour: 9 })
  })

  it('leaves an instant already inside the window untouched', () => {
    const inside = fromIst(2026, 9, 15, 14)
    expect(nextIstWindowStart(inside, 9, 20)).toBe(inside)
  })
})
