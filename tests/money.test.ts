import { describe, expect, it } from 'vitest'

import {
  ZERO_PAISE,
  addP,
  clampP,
  formatINR,
  formatINRCompact,
  fromRupees,
  paise,
  pctOf,
  scaleP,
  splitPaise,
  subP,
  sumPaise,
  toRupees,
} from '../src/core/money'

describe('Paise', () => {
  it('accepts whole paise', () => {
    expect(paise(0)).toBe(0)
    expect(paise(-250)).toBe(-250)
    expect(paise(123_456_789)).toBe(123_456_789)
  })

  it('rejects fractional paise, which is how a float leaks onto the money path', () => {
    expect(() => paise(10.5)).toThrow(/safe integer/)
    expect(() => paise(0.1 + 0.2)).toThrow(/safe integer/)
  })

  it('rejects non-finite and unsafe values', () => {
    expect(() => paise(Number.NaN)).toThrow()
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })

  it('converts rupees that land on a whole paise', () => {
    expect(fromRupees(1)).toBe(100)
    expect(fromRupees(1234.56)).toBe(123_456)
    expect(fromRupees(0.01)).toBe(1)
  })

  it('refuses rupee amounts finer than a paise', () => {
    expect(() => fromRupees(1.234)).toThrow(/whole paise/)
  })

  it('round-trips through rupees for display', () => {
    expect(toRupees(fromRupees(499.99))).toBeCloseTo(499.99, 10)
  })
})

describe('arithmetic', () => {
  it('adds, subtracts and sums', () => {
    expect(addP(paise(100), paise(250), paise(1))).toBe(351)
    expect(subP(paise(100), paise(250))).toBe(-150)
    expect(sumPaise([paise(10), paise(20), paise(30)])).toBe(60)
    expect(sumPaise([])).toBe(0)
  })

  it('scales to a whole paise', () => {
    expect(scaleP(paise(333), 0.5)).toBe(167)
    expect(scaleP(paise(100), 0)).toBe(0)
  })

  it('takes a percentage without floats escaping', () => {
    expect(pctOf(paise(123_456), 10)).toBe(12_346)
    expect(pctOf(paise(100_000), 2.5)).toBe(2_500)
  })

  it('clamps within bounds', () => {
    expect(clampP(paise(500), paise(0), paise(100))).toBe(100)
    expect(clampP(paise(-500), paise(0), paise(100))).toBe(0)
    expect(() => clampP(paise(0), paise(100), paise(0))).toThrow()
  })
})

describe('splitPaise', () => {
  it('puts the remainder on the last instalment so the total is preserved', () => {
    const parts = splitPaise(paise(100), 3)
    expect(parts).toEqual([33, 33, 34])
    expect(sumPaise(parts)).toBe(100)
  })

  it('splits evenly when it divides cleanly', () => {
    expect(splitPaise(paise(900), 3)).toEqual([300, 300, 300])
  })

  it('handles a single part and preserves the total for awkward amounts', () => {
    expect(splitPaise(paise(7), 1)).toEqual([7])
    for (const total of [1, 7, 99, 100_001, 123_457]) {
      for (const parts of [2, 3, 7, 12]) {
        expect(sumPaise(splitPaise(paise(total), parts))).toBe(total)
      }
    }
  })

  it('rejects a non-positive part count', () => {
    expect(() => splitPaise(paise(100), 0)).toThrow()
    expect(() => splitPaise(paise(100), 2.5)).toThrow()
  })
})

describe('formatINR', () => {
  it('uses Indian digit grouping', () => {
    expect(formatINR(paise(12_345_678))).toBe('₹1,23,456.78')
    expect(formatINR(paise(100_000_000))).toBe('₹10,00,000.00')
  })

  it('always shows two decimal places', () => {
    expect(formatINR(ZERO_PAISE)).toBe('₹0.00')
    expect(formatINR(paise(5))).toBe('₹0.05')
    expect(formatINR(paise(150))).toBe('₹1.50')
  })

  it('renders negatives with the sign outside the symbol', () => {
    expect(formatINR(paise(-12_345))).toBe('-₹123.45')
  })

  it('is exact at large magnitudes where a float divide would drift', () => {
    expect(formatINR(paise(999_999_999_999))).toBe('₹9,99,99,99,999.99')
  })
})

describe('formatINRCompact', () => {
  it('uses thousands, lakh and crore', () => {
    expect(formatINRCompact(paise(250_000))).toBe('₹2.5k')
    expect(formatINRCompact(paise(31_000_000))).toBe('₹3.1L')
    expect(formatINRCompact(paise(4_500_000_000))).toBe('₹4.5Cr')
  })

  it('trims trailing zeros without eating an integer digit', () => {
    expect(formatINRCompact(paise(10_000_000))).toBe('₹1L')
    expect(formatINRCompact(paise(300_000_000))).toBe('₹30L')
    expect(formatINRCompact(paise(12_500_000))).toBe('₹1.25L')
  })

  it('falls back to the full format below a thousand rupees', () => {
    expect(formatINRCompact(paise(45_000))).toBe('₹450.00')
  })

  it('keeps the sign', () => {
    expect(formatINRCompact(paise(-31_000_000))).toBe('-₹3.1L')
  })
})
