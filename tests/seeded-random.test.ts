import { describe, expect, it } from 'vitest'

import { createRng } from '../src/core/seeded-random'

describe('createRng', () => {
  it('replays identically for the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const drawsA = Array.from({ length: 100 }, () => a.next())
    const drawsB = Array.from({ length: 100 }, () => b.next())
    expect(drawsA).toEqual(drawsB)
  })

  it('diverges for different seeds', () => {
    const one = createRng(1)
    const two = createRng(2)
    const a = Array.from({ length: 20 }, () => one.next())
    const b = Array.from({ length: 20 }, () => two.next())
    expect(a).not.toEqual(b)
  })

  it('accepts a string seed', () => {
    expect(createRng('recoup').next()).toBe(createRng('recoup').next())
    expect(createRng('recoup').next()).not.toBe(createRng('recoup-2').next())
  })

  it('produces values in [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('derived streams', () => {
  it('gives a child stream that is stable for a label', () => {
    const first = createRng(42).derive('timing').next()
    const second = createRng(42).derive('timing').next()
    expect(first).toBe(second)
  })

  it('keeps sibling streams independent so adding a consumer does not shift another', () => {
    const parent = createRng(42)
    const timing = parent.derive('timing')
    const before = Array.from({ length: 10 }, () => timing.next())

    const parentAgain = createRng(42)
    parentAgain.derive('newly-added-consumer')
    const timingAgain = parentAgain.derive('timing')
    const after = Array.from({ length: 10 }, () => timingAgain.next())

    expect(after).toEqual(before)
  })

  it('gives different sequences to different labels', () => {
    const rng = createRng(42)
    expect(rng.derive('a').next()).not.toBe(rng.derive('b').next())
  })
})

describe('distributions', () => {
  it('int stays within bounds and covers them', () => {
    const rng = createRng(3)
    const seen = new Set<number>()
    for (let i = 0; i < 2_000; i++) {
      const value = rng.int(5, 10)
      expect(value).toBeGreaterThanOrEqual(5)
      expect(value).toBeLessThan(10)
      seen.add(value)
    }
    expect(seen.size).toBe(5)
  })

  it('int rejects an empty or non-integer range', () => {
    const rng = createRng(3)
    expect(() => rng.int(5, 5)).toThrow()
    expect(() => rng.int(0, 1.5)).toThrow()
  })

  it('bool approximates its probability', () => {
    const rng = createRng(11)
    let hits = 0
    for (let i = 0; i < 20_000; i++) if (rng.bool(0.3)) hits++
    expect(hits / 20_000).toBeCloseTo(0.3, 1)
  })

  it('bool rejects a probability outside [0,1]', () => {
    expect(() => createRng(1).bool(1.5)).toThrow()
  })

  it('weighted respects the weights', () => {
    const rng = createRng(5)
    const counts = { a: 0, b: 0 }
    for (let i = 0; i < 20_000; i++) {
      counts[
        rng.weighted([
          ['a', 3],
          ['b', 1],
        ] as const)
      ]++
    }
    expect(counts.a / (counts.a + counts.b)).toBeCloseTo(0.75, 1)
  })

  it('weighted rejects zero total weight', () => {
    expect(() =>
      createRng(1).weighted([
        ['a', 0],
        ['b', 0],
      ] as const),
    ).toThrow()
  })

  it('shuffle is a permutation and is deterministic', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    const a = createRng(9).shuffle(input)
    const b = createRng(9).shuffle(input)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('sample returns at most the requested count', () => {
    const rng = createRng(4)
    expect(rng.sample([1, 2, 3], 5)).toHaveLength(3)
    expect(rng.sample([1, 2, 3, 4], 2)).toHaveLength(2)
  })

  it('normal has roughly the requested mean and spread', () => {
    const rng = createRng(13)
    const draws = Array.from({ length: 20_000 }, () => rng.normal(10, 2))
    const mean = draws.reduce((sum, x) => sum + x, 0) / draws.length
    const variance = draws.reduce((sum, x) => sum + (x - mean) ** 2, 0) / draws.length
    expect(mean).toBeCloseTo(10, 1)
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1)
  })

  it('exponential is positive with the right mean', () => {
    const rng = createRng(17)
    const draws = Array.from({ length: 20_000 }, () => rng.exponential(0.5))
    expect(Math.min(...draws)).toBeGreaterThan(0)
    expect(draws.reduce((sum, x) => sum + x, 0) / draws.length).toBeCloseTo(2, 0)
  })

  it('beta stays in [0,1] and centres on a/(a+b) for Thompson sampling', () => {
    const rng = createRng(19)
    const draws = Array.from({ length: 20_000 }, () => rng.beta(2, 8))
    for (const value of draws.slice(0, 500)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(draws.reduce((sum, x) => sum + x, 0) / draws.length).toBeCloseTo(0.2, 1)
  })

  it('gamma handles shape below one', () => {
    const rng = createRng(23)
    const draws = Array.from({ length: 5_000 }, () => rng.gamma(0.5))
    expect(Math.min(...draws)).toBeGreaterThan(0)
    expect(draws.every(Number.isFinite)).toBe(true)
  })

  it('gamma rejects a non-positive shape', () => {
    expect(() => createRng(1).gamma(0)).toThrow()
  })
})
