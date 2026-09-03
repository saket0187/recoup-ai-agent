import { describe, expect, it } from 'vitest'

import { fromIst } from '../src/core/calendar'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import { DegradationDetector, cohortKey, wilsonLowerBound } from '../src/signal/degradation'
import {
  attributeRootCause,
  describeAttribution,
  type CellObservation,
} from '../src/signal/root-cause'

const HOUR = 3_600_000
const DAY = 86_400_000

function feed(
  detector: DegradationDetector,
  at: number,
  issuer: string,
  count: number,
  successRate: number,
  seed = 1,
): void {
  const rng = createRng(seed)
  for (let i = 0; i < count; i++) {
    detector.observe(at - i * 1_000, 'upi', issuer, rng.bool(successRate), paise(50_000))
  }
}

function warmUp(
  detector: DegradationDetector,
  startAt: number,
  issuer: string,
  rate = 0.92,
): number {
  let at = startAt
  for (let day = 0; day < 5; day++) {
    feed(detector, at, issuer, 120, rate, day + 1)
    detector.learnBaselines(at)
    at += DAY
  }
  return at
}

describe('wilsonLowerBound', () => {
  it('is far below the point estimate on thin evidence', () => {
    expect(wilsonLowerBound(9, 10)).toBeLessThan(0.75)
  })

  it('tightens towards the point estimate as volume grows', () => {
    expect(wilsonLowerBound(9_000, 10_000)).toBeGreaterThan(0.89)
  })

  it('is zero with no observations', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
  })
})

describe('DegradationDetector', () => {
  const start = fromIst(2026, 9, 1, 14)

  it('detects a genuine collapse on a high-volume cohort', () => {
    const detector = new DegradationDetector()
    const outageAt = warmUp(detector, start, 'HDFC')

    feed(detector, outageAt, 'HDFC', 120, 0.15, 99)
    detector.evaluate(outageAt)
    const health = detector.evaluate(outageAt).find((row) => row.key === cohortKey('upi', 'HDFC'))

    expect(health?.state).toBe('DEGRADED')
    expect(health?.dropPp).toBeGreaterThan(0.5)
    expect(health?.amountAtRiskPaise).toBeGreaterThan(0)
  })

  it('stays healthy when nothing changes', () => {
    const detector = new DegradationDetector()
    const at = warmUp(detector, start, 'HDFC')

    feed(detector, at, 'HDFC', 120, 0.92, 42)
    expect(detector.evaluate(at)[0]?.state).toBe('HEALTHY')
  })

  it('raises no alarm across a full week of ordinary variation', () => {
    const detector = new DegradationDetector()
    let at = start
    const alarms: string[] = []

    for (let day = 0; day < 12; day++) {
      for (const hour of [10, 14, 18, 22]) {
        const slot = at + hour * HOUR
        feed(detector, slot, 'HDFC', 120, 0.92, day * 10 + hour)
        detector.learnBaselines(slot)
        if (day >= 5) {
          for (const health of detector.evaluate(slot)) {
            if (health.state === 'DEGRADED') alarms.push(`day ${day} hour ${hour}`)
          }
        }
      }
      at += DAY
    }

    expect(alarms).toEqual([])
  })

  it('suppresses a low-volume cohort rather than alerting on noise', () => {
    const detector = new DegradationDetector()
    const at = warmUp(detector, start, 'YES')

    feed(detector, at + DAY, 'YES', 6, 0, 7)
    const health = detector.evaluate(at + DAY).find((row) => row.key === cohortKey('upi', 'YES'))

    expect(health?.suppressedForVolume).toBe(true)
    expect(health?.state).toBe('HEALTHY')
  })

  it('reports an onset earlier than the moment of detection', () => {
    const detector = new DegradationDetector()
    const outageAt = warmUp(detector, start, 'HDFC')

    feed(detector, outageAt, 'HDFC', 120, 0.1, 5)
    detector.evaluate(outageAt)
    const health = detector.evaluate(outageAt).find((row) => row.key === cohortKey('upi', 'HDFC'))

    expect(health?.onsetAt).toBeDefined()
    expect(health?.onsetAt ?? Infinity).toBeLessThanOrEqual(outageAt)
  })

  it('does not learn the outage as the new normal', () => {
    const detector = new DegradationDetector()
    const outageAt = warmUp(detector, start, 'HDFC')

    feed(detector, outageAt, 'HDFC', 120, 0.1, 5)
    detector.evaluate(outageAt)
    const during = detector.evaluate(outageAt)
    detector.learnBaselines(outageAt)

    const baselineDuring = during.find((row) => row.key === cohortKey('upi', 'HDFC'))?.baseline ?? 0
    expect(baselineDuring).toBeGreaterThan(0.8)
  })

  it('keeps cohorts independent', () => {
    const detector = new DegradationDetector()
    let at = start
    for (let day = 0; day < 5; day++) {
      feed(detector, at, 'HDFC', 120, 0.92, day + 1)
      feed(detector, at, 'ICICI', 120, 0.92, day + 50)
      detector.learnBaselines(at)
      at += DAY
    }

    feed(detector, at, 'HDFC', 120, 0.1, 9)
    feed(detector, at, 'ICICI', 120, 0.92, 11)

    detector.evaluate(at)
    const health = detector.evaluate(at)
    expect(health.find((row) => row.issuer === 'HDFC')?.state).toBe('DEGRADED')
    expect(health.find((row) => row.issuer === 'ICICI')?.state).toBe('HEALTHY')
  })
})

describe('attributeRootCause', () => {
  const dimensions = ['method', 'issuer']

  const cell = (
    method: string,
    issuer: string,
    attempts: number,
    successes: number,
    baselineRate: number,
  ): CellObservation => ({
    dims: { method, issuer },
    attempts,
    successes,
    baselineRate,
    amountAtRiskPaise: paise((attempts - successes) * 50_000),
  })

  it('isolates the single failing cell without implicating healthy ones', () => {
    const attribution = attributeRootCause(
      [
        cell('upi', 'HDFC', 200, 20, 0.9),
        cell('upi', 'ICICI', 200, 180, 0.9),
        cell('card', 'HDFC', 200, 170, 0.85),
        cell('card', 'ICICI', 200, 170, 0.85),
      ],
      dimensions,
    )

    expect(attribution.cells).toHaveLength(1)
    expect(attribution.cells[0]?.dims).toEqual({ method: 'upi', issuer: 'HDFC' })
    expect(attribution.explainedFraction).toBeGreaterThan(0.95)
  })

  it('rolls up to the issuer when every method on that issuer is affected', () => {
    const attribution = attributeRootCause(
      [
        cell('upi', 'HDFC', 200, 20, 0.9),
        cell('card', 'HDFC', 200, 15, 0.85),
        cell('upi', 'ICICI', 200, 180, 0.9),
        cell('card', 'ICICI', 200, 170, 0.85),
      ],
      dimensions,
    )

    expect(attribution.cells).toHaveLength(1)
    expect(attribution.cells[0]?.dims).toEqual({ issuer: 'HDFC' })
  })

  it('rolls up to the method when every issuer on that method is affected', () => {
    const attribution = attributeRootCause(
      [
        cell('upi', 'HDFC', 200, 20, 0.9),
        cell('upi', 'ICICI', 200, 25, 0.9),
        cell('card', 'HDFC', 200, 170, 0.85),
        cell('card', 'ICICI', 200, 170, 0.85),
      ],
      dimensions,
    )

    expect(attribution.cells).toHaveLength(1)
    expect(attribution.cells[0]?.dims).toEqual({ method: 'upi' })
  })

  it('reports two independent cells when two things broke', () => {
    const attribution = attributeRootCause(
      [
        cell('upi', 'HDFC', 200, 20, 0.9),
        cell('card', 'SBI', 200, 15, 0.85),
        cell('upi', 'ICICI', 200, 180, 0.9),
        cell('card', 'ICICI', 200, 170, 0.85),
      ],
      dimensions,
    )

    expect(attribution.cells).toHaveLength(2)
    expect(attribution.explainedFraction).toBeGreaterThan(0.95)
  })

  it('returns nothing to explain when the world is healthy', () => {
    const attribution = attributeRootCause(
      [cell('upi', 'HDFC', 200, 180, 0.9), cell('card', 'ICICI', 200, 170, 0.85)],
      dimensions,
    )

    expect(attribution.cells).toEqual([])
    expect(attribution.totalDeficit).toBe(0)
    expect(describeAttribution(attribution)).toBe('no deviation to explain')
  })

  it('sums the money at risk across the attributed cells', () => {
    const attribution = attributeRootCause(
      [cell('upi', 'HDFC', 200, 20, 0.9), cell('upi', 'ICICI', 200, 180, 0.9)],
      dimensions,
    )

    expect(attribution.amountAtRiskPaise).toBe(180 * 50_000)
  })

  it('is deterministic across repeated runs', () => {
    const observations = [
      cell('upi', 'HDFC', 200, 20, 0.9),
      cell('upi', 'ICICI', 200, 180, 0.9),
      cell('card', 'HDFC', 200, 170, 0.85),
    ]
    const first = attributeRootCause(observations, dimensions)
    const second = attributeRootCause(observations, dimensions)
    expect(first).toEqual(second)
  })

  it('renders a human-readable summary', () => {
    const attribution = attributeRootCause(
      [
        cell('upi', 'HDFC', 200, 20, 0.9),
        cell('upi', 'ICICI', 200, 180, 0.9),
        cell('card', 'HDFC', 200, 170, 0.85),
      ],
      dimensions,
    )
    expect(describeAttribution(attribution)).toMatch(/method=upi, issuer=HDFC/)
    expect(describeAttribution(attribution)).toMatch(/of the deviation explained/)
  })
})
