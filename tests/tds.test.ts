import { describe, expect, it } from 'vitest'

import { paise } from '../src/core/money'
import { describeTdsMatch, detectTdsShortfall } from '../src/ledger/tds'

describe('detectTdsShortfall', () => {
  it('recognises a 10% professional-services deduction on a GST-free invoice', () => {
    const match = detectTdsShortfall(paise(10_000_000), paise(9_000_000), { gstRatesPct: [0] })
    expect(match?.section).toBe('194J-professional')
    expect(match?.ratePct).toBe(10)
    expect(match?.expectedDeductionPaise).toBe(1_000_000)
  })

  it('recognises a 2% contractor deduction', () => {
    const match = detectTdsShortfall(paise(5_000_000), paise(4_900_000), { gstRatesPct: [0] })
    expect(match?.ratePct).toBe(2)
  })

  it('recognises a deduction computed on the value net of 18% GST', () => {
    const invoice = 11_800_000
    const taxableBase = Math.round(invoice / 1.18)
    const deduction = Math.round(taxableBase * 0.1)

    const match = detectTdsShortfall(paise(invoice), paise(invoice - deduction))

    expect(match).not.toBeNull()
    expect(match?.ratePct).toBe(10)
    expect(match?.gstRatePct).toBe(18)
    expect(match?.taxableBasePaise).toBe(taxableBase)
  })

  it('absorbs a small rounding difference', () => {
    const match = detectTdsShortfall(paise(10_000_000), paise(9_000_037), { gstRatesPct: [0] })
    expect(match?.ratePct).toBe(10)
    expect(match?.variancePaise).toBe(37)
  })

  it('rejects a shortfall that is not close to any known rate', () => {
    expect(detectTdsShortfall(paise(10_000_000), paise(9_300_000), { gstRatesPct: [0] })).toBeNull()
  })

  it('returns null when nothing is short', () => {
    expect(detectTdsShortfall(paise(10_000_000), paise(10_000_000))).toBeNull()
    expect(detectTdsShortfall(paise(10_000_000), paise(10_500_000))).toBeNull()
  })

  it('returns null when nothing at all was paid', () => {
    expect(detectTdsShortfall(paise(10_000_000), paise(0))).toBeNull()
  })

  it('prefers the interpretation with the smallest variance', () => {
    const match = detectTdsShortfall(paise(10_000_000), paise(9_800_000), { gstRatesPct: [0] })
    expect(match?.ratePct).toBe(2)
    expect(match?.variancePaise).toBe(0)
  })

  it('honours a tighter tolerance', () => {
    const loose = detectTdsShortfall(paise(10_000_000), paise(9_000_050), { gstRatesPct: [0] })
    expect(loose?.variancePaise).toBe(50)

    const strict = detectTdsShortfall(paise(10_000_000), paise(9_000_050), {
      gstRatesPct: [0],
      tolerancePaise: paise(10),
    })
    expect(strict).toBeNull()
  })

  it('does not match a shortfall that misses the rupee-rounded deduction', () => {
    expect(detectTdsShortfall(paise(10_000_000), paise(9_000_500), { gstRatesPct: [0] })).toBeNull()
  })

  it('describes the match in terms an accounts team would recognise', () => {
    const match = detectTdsShortfall(paise(10_000_000), paise(9_000_000), { gstRatesPct: [0] })
    expect(match).not.toBeNull()
    if (match !== null) {
      expect(describeTdsMatch(match)).toBe('194J-professional at 10% on the taxable value (no GST)')
    }
  })

  it('reports the actual shortfall alongside the expected deduction', () => {
    const match = detectTdsShortfall(paise(10_000_000), paise(9_000_000), { gstRatesPct: [0] })
    expect(match?.actualShortfallPaise).toBe(1_000_000)
  })
})
