import { describe, expect, it } from 'vitest'

import { paise } from '../src/core/money'
import { StratifiedAssigner, amountBand, stratumKey } from '../src/experiment/arm'

describe('amountBand', () => {
  it('bands by order of magnitude', () => {
    expect(amountBand(paise(20_000))).toBe('micro')
    expect(amountBand(paise(200_000))).toBe('low')
    expect(amountBand(paise(1_000_000))).toBe('mid')
    expect(amountBand(paise(5_000_000))).toBe('high')
    expect(amountBand(paise(50_000_000))).toBe('enterprise')
  })

  it('puts a boundary value in the higher band', () => {
    expect(amountBand(paise(49_999))).toBe('micro')
    expect(amountBand(paise(50_000))).toBe('low')
  })

  it('builds a stratum key from band and failure class', () => {
    expect(stratumKey(paise(200_000), 'FUNDS_TIMING')).toBe('low|FUNDS_TIMING')
  })
})

describe('StratifiedAssigner', () => {
  const keys = Array.from({ length: 4_000 }, (_, i) => `obl_${i}`)

  it('assigns roughly the intended share to treatment', () => {
    const assigner = new StratifiedAssigner('salt')
    for (const key of keys) assigner.assign('low|FUNDS_TIMING', key)

    const totals = assigner.totals()
    expect(totals.TREATMENT / keys.length).toBeCloseTo(0.8, 1)
  })

  it('gives the same case the same arm no matter when it arrives', () => {
    const forwards = new StratifiedAssigner('salt')
    const backwards = new StratifiedAssigner('salt')

    const first = keys.map((key) => forwards.assign('low|FUNDS_TIMING', key))
    const reversed = [...keys].reverse().map((key) => backwards.assign('low|FUNDS_TIMING', key))

    expect(reversed.reverse()).toEqual(first)
  })

  it('is unaffected by cases it has never seen, so ablations compare like with like', () => {
    const sparse = new StratifiedAssigner('salt')
    const dense = new StratifiedAssigner('salt')

    const target = 'obl_500'
    const sparseArm = sparse.assign('low|FUNDS_TIMING', target)

    for (const key of keys.slice(0, 200)) dense.assign('low|FUNDS_TIMING', key)
    const denseArm = dense.assign('low|FUNDS_TIMING', target)

    expect(denseArm).toBe(sparseArm)
  })

  it('separates strata, so the same case can land differently in a different stratum', () => {
    const assigner = new StratifiedAssigner('salt')
    const arms = new Set(
      ['low|FUNDS_TIMING', 'high|RISK_DECLINE', 'mid|AUTH_DROPOFF'].map((stratum) =>
        assigner.assign(stratum, 'obl_1'),
      ),
    )
    expect(arms.size).toBeGreaterThanOrEqual(1)
    expect(assigner.strata()).toHaveLength(3)
  })

  it('produces a different split for a different salt', () => {
    const a = new StratifiedAssigner('salt-a')
    const b = new StratifiedAssigner('salt-b')

    const armsA = keys.slice(0, 200).map((key) => a.assign('s', key))
    const armsB = keys.slice(0, 200).map((key) => b.assign('s', key))

    expect(armsA).not.toEqual(armsB)
  })

  it('honours a custom treatment share', () => {
    const assigner = new StratifiedAssigner('salt', { treatmentShare: 0.5 })
    for (const key of keys) assigner.assign('s', key)
    expect(assigner.totals().TREATMENT / keys.length).toBeCloseTo(0.5, 1)
  })

  it('rejects a share that would empty an arm', () => {
    expect(() => new StratifiedAssigner('salt', { treatmentShare: 0 })).toThrow()
    expect(() => new StratifiedAssigner('salt', { treatmentShare: 1 })).toThrow()
  })

  it('tallies per stratum', () => {
    const assigner = new StratifiedAssigner('salt')
    for (const key of keys.slice(0, 100)) assigner.assign('a', key)
    const tally = assigner.tally('a')
    expect(tally.TREATMENT + tally.CONTROL).toBe(100)
    expect(assigner.tally('never-seen')).toEqual({ TREATMENT: 0, CONTROL: 0 })
  })
})
