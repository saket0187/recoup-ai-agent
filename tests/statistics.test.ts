import { describe, expect, it } from 'vitest'

import { createRng } from '../src/core/seeded-random'
import {
  bootstrapDifferenceOfMeans,
  compareProportions,
  excludesZero,
  mean,
  standardDeviation,
  wilsonInterval,
} from '../src/core/statistics'

describe('summary statistics', () => {
  it('computes a mean and a sample standard deviation', () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(standardDeviation([2, 4, 6])).toBeCloseTo(2, 6)
    expect(mean([])).toBe(0)
    expect(standardDeviation([5])).toBe(0)
  })
})

describe('wilsonInterval', () => {
  it('brackets the point estimate', () => {
    const interval = wilsonInterval(30, 100)
    expect(interval.estimate).toBe(0.3)
    expect(interval.lower).toBeLessThan(0.3)
    expect(interval.upper).toBeGreaterThan(0.3)
  })

  it('narrows as evidence accumulates', () => {
    const thin = wilsonInterval(3, 10)
    const thick = wilsonInterval(3_000, 10_000)
    expect(thick.upper - thick.lower).toBeLessThan(thin.upper - thin.lower)
  })

  it('never leaves the unit interval', () => {
    expect(wilsonInterval(0, 5).lower).toBe(0)
    expect(wilsonInterval(5, 5).upper).toBe(1)
  })
})

describe('compareProportions', () => {
  it('finds no significance in a small difference on thin evidence', () => {
    const comparison = compareProportions(11, 30, 10, 30)
    expect(comparison.significantAt95).toBe(false)
  })

  it('finds significance in a large difference on thick evidence', () => {
    const comparison = compareProportions(600, 1_000, 400, 1_000)
    expect(comparison.difference).toBeCloseTo(0.2, 6)
    expect(comparison.significantAt95).toBe(true)
  })

  it('reports a negative difference when the treatment is worse', () => {
    const comparison = compareProportions(300, 1_000, 500, 1_000)
    expect(comparison.difference).toBeLessThan(0)
    expect(comparison.significantAt95).toBe(true)
  })

  it('degrades safely when an arm is empty', () => {
    expect(compareProportions(0, 0, 5, 10).significantAt95).toBe(false)
  })
})

describe('bootstrapDifferenceOfMeans', () => {
  const rng = () => createRng(42).derive('bootstrap')

  it('recovers a known difference as its point estimate', () => {
    const treatment = Array.from({ length: 400 }, (_, i) => 100 + (i % 10))
    const control = Array.from({ length: 400 }, (_, i) => 50 + (i % 10))
    const interval = bootstrapDifferenceOfMeans(treatment, control, rng())
    expect(interval.estimate).toBeCloseTo(50, 6)
  })

  it('brackets the estimate with lower below and upper above', () => {
    const treatment = Array.from({ length: 300 }, (_, i) => (i % 7) * 10)
    const control = Array.from({ length: 300 }, (_, i) => (i % 5) * 10)
    const interval = bootstrapDifferenceOfMeans(treatment, control, rng())
    expect(interval.lower).toBeLessThanOrEqual(interval.estimate)
    expect(interval.upper).toBeGreaterThanOrEqual(interval.estimate)
  })

  it('spans zero when the two arms are drawn from the same distribution', () => {
    const source = createRng(7).derive('sample')
    const treatment = Array.from({ length: 500 }, () => source.normal(100, 30))
    const control = Array.from({ length: 500 }, () => source.normal(100, 30))
    const interval = bootstrapDifferenceOfMeans(treatment, control, rng())
    expect(excludesZero(interval)).toBe(false)
  })

  it('excludes zero when the arms genuinely differ', () => {
    const source = createRng(9).derive('sample')
    const treatment = Array.from({ length: 500 }, () => source.normal(150, 20))
    const control = Array.from({ length: 500 }, () => source.normal(100, 20))
    const interval = bootstrapDifferenceOfMeans(treatment, control, rng())
    expect(excludesZero(interval)).toBe(true)
    expect(interval.lower).toBeGreaterThan(0)
  })

  it('widens the interval as the sample shrinks', () => {
    const source = createRng(11).derive('sample')
    const big = Array.from({ length: 2_000 }, () => source.normal(100, 40))
    const small = big.slice(0, 40)
    const control = Array.from({ length: 2_000 }, () => source.normal(100, 40))

    const wide = bootstrapDifferenceOfMeans(small, control.slice(0, 40), rng())
    const narrow = bootstrapDifferenceOfMeans(big, control, rng())

    expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower)
  })

  it('replays identically for the same seed', () => {
    const treatment = Array.from({ length: 100 }, (_, i) => i)
    const control = Array.from({ length: 100 }, (_, i) => i / 2)
    expect(bootstrapDifferenceOfMeans(treatment, control, rng())).toEqual(
      bootstrapDifferenceOfMeans(treatment, control, rng()),
    )
  })

  it('returns a zero interval rather than NaN when an arm is empty', () => {
    expect(bootstrapDifferenceOfMeans([], [1, 2, 3], rng())).toEqual({
      estimate: 0,
      lower: 0,
      upper: 0,
    })
  })
})

describe('excludesZero', () => {
  it('is false for an interval straddling zero', () => {
    expect(excludesZero({ estimate: 1, lower: -2, upper: 4 })).toBe(false)
  })

  it('is true for a wholly positive or wholly negative interval', () => {
    expect(excludesZero({ estimate: 3, lower: 1, upper: 4 })).toBe(true)
    expect(excludesZero({ estimate: -3, lower: -4, upper: -1 })).toBe(true)
  })
})
