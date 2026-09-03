import { describe, expect, it } from 'vitest'

import { createRng } from '../src/core/seeded-random'
import { evaluatePolicy, type LoggedDecision } from '../src/measurement/off-policy'

const rng = createRng(7).derive('off-policy-test')

function rows(count: number, propensity: number, reward: (i: number) => number): LoggedDecision[] {
  return Array.from({ length: count }, (_, i) => ({
    caseId: `case_${i}`,
    stratum: 'mid|FUNDS_TIMING',
    action: i % 2 === 0 ? 'RETRY_CHARGE' : 'WAIT',
    propensity,
    reward: reward(i),
  }))
}

describe('off-policy estimators', () => {
  it('recovers the observed mean when the logging policy was deterministic', () => {
    const logged = rows(200, 1, (i) => (i % 4 === 0 ? 1 : 0))
    const observed = logged.reduce((s, r) => s + r.reward, 0) / logged.length

    const result = evaluatePolicy(logged, 'replay', (row) => row.action, rng, { iterations: 50 })

    expect(result.ips.estimate).toBeCloseTo(observed, 12)
    expect(result.snips.estimate).toBeCloseTo(observed, 12)
    expect(result.overlap).toBe(1)
  })

  it('up-weights rare actions in proportion to how rarely they were taken', () => {
    const logged = rows(200, 0.25, (i) => (i % 2 === 0 ? 1 : 0))
    const result = evaluatePolicy(logged, 'always retry', () => 'RETRY_CHARGE', rng, {
      iterations: 50,
    })

    expect(result.ips.estimate).toBeCloseTo(2, 6)
    expect(result.snips.estimate).toBeCloseTo(1, 6)
    expect(result.overlap).toBeCloseTo(0.5, 6)
  })

  it('reports a collapsed effective sample size for a policy far from the logged one', () => {
    const logged: LoggedDecision[] = rows(200, 0.5, () => 1).map((row, i) => ({
      ...row,
      action: i === 0 ? 'OFFER_PLAN' : 'WAIT',
    }))

    const result = evaluatePolicy(logged, 'always offer', () => 'OFFER_PLAN', rng, {
      iterations: 50,
    })

    expect(result.overlap).toBeCloseTo(1 / 200, 6)
    expect(result.effectiveSampleSize).toBeLessThan(2)
  })

  it('clips extreme weights rather than letting one row dominate', () => {
    const logged = rows(100, 0.001, () => 1)
    const result = evaluatePolicy(logged, 'replay', (row) => row.action, rng, {
      iterations: 20,
      clip: 10,
    })

    expect(result.clipped).toBe(100)
    expect(result.ips.estimate).toBeCloseTo(10, 6)
  })

  it('returns zeroes rather than dividing by nothing on an empty log', () => {
    const result = evaluatePolicy([], 'none', () => 'WAIT', rng, { iterations: 10 })
    expect(result.rows).toBe(0)
    expect(result.snips.estimate).toBe(0)
    expect(result.effectiveSampleSize).toBe(0)
  })
})

describe('clustered resampling', () => {
  it('widens the interval when rows are correlated within a case', () => {
    const correlated: LoggedDecision[] = []
    for (let c = 0; c < 40; c++) {
      const reward = c % 2 === 0 ? 1 : 0
      for (let k = 0; k < 10; k++) {
        correlated.push({
          caseId: `case_${c}`,
          stratum: 'mid|FUNDS_TIMING',
          action: 'RETRY_CHARGE',
          propensity: 0.5,
          reward,
        })
      }
    }

    const independent = correlated.map((row, i) => ({ ...row, caseId: `case_solo_${i}` }))

    const clustered = evaluatePolicy(correlated, 'replay', (r) => r.action, createRng(11), {
      iterations: 300,
    })
    const naive = evaluatePolicy(independent, 'replay', (r) => r.action, createRng(11), {
      iterations: 300,
    })

    const width = (i: { lower: number; upper: number }): number => i.upper - i.lower
    expect(width(clustered.snips)).toBeGreaterThan(width(naive.snips) * 2)
  })

  it('keeps every row of a case together when it resamples', () => {
    const rows: LoggedDecision[] = Array.from({ length: 30 }, (_, i) => ({
      caseId: `case_${Math.floor(i / 3)}`,
      stratum: 'mid|FUNDS_TIMING',
      action: 'RETRY_CHARGE',
      propensity: 1,
      reward: 1,
    }))

    const result = evaluatePolicy(rows, 'replay', (r) => r.action, createRng(3), {
      iterations: 30,
    })

    expect(result.snips.lower).toBeCloseTo(1, 9)
    expect(result.snips.upper).toBeCloseTo(1, 9)
  })
})
