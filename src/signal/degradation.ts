import { istHour, istWeekday } from '../core/calendar'
import { paise, type Paise } from '../core/money'
import { DEFAULT_Z, wilsonInterval } from '../core/statistics'
import type { CohortState, PaymentMethod } from '../domain/enums'

export interface DetectorConfig {
  readonly windowMs: number
  readonly minVolume: number
  readonly dropThreshold: number
  readonly ewmaAlpha: number
  readonly cusumSlack: number
  readonly cusumThreshold: number
  readonly baselineWarmupWindows: number
  readonly consecutiveWindowsToAlert: number
  readonly significanceZ: number
}

const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  windowMs: 15 * 60_000,
  minVolume: 30,
  dropThreshold: 0.06,
  ewmaAlpha: 0.2,
  cusumSlack: 0.05,
  cusumThreshold: 4,
  baselineWarmupWindows: 4,
  consecutiveWindowsToAlert: 2,
  significanceZ: 3.2,
}

export interface CohortHealth {
  readonly key: string
  readonly method: PaymentMethod
  readonly issuer: string
  readonly attempts: number
  readonly successes: number
  readonly observedRate: number
  readonly wilsonLcb: number
  readonly baseline: number
  readonly dropPp: number
  readonly state: CohortState
  readonly onsetAt: number | undefined
  readonly amountAtRiskPaise: Paise
  readonly suppressedForVolume: boolean
  readonly suppressedForBaseline: boolean
}

interface Attempt {
  readonly at: number
  readonly succeeded: boolean
  readonly amountPaise: number
}

interface CohortStateRecord {
  readonly method: PaymentMethod
  readonly issuer: string
  attempts: Attempt[]
  cusum: number
  cusumRunStartedAt: number | undefined
  onsetAt: number | undefined
  degraded: boolean
  suspect: boolean
  consecutiveDegraded: number
}

export function wilsonLowerBound(successes: number, attempts: number, z = DEFAULT_Z): number {
  return wilsonInterval(successes, attempts, z).lower
}

function wilsonUpperBound(successes: number, attempts: number, z = DEFAULT_Z): number {
  return wilsonInterval(successes, attempts, z).upper
}

export function cohortKey(method: PaymentMethod, issuer: string): string {
  return `${method}|${issuer}`
}

function seasonalKey(method: PaymentMethod, issuer: string, at: number): string {
  const weekend = istWeekday(at) === 0 || istWeekday(at) === 6 ? 'we' : 'wd'
  return `${cohortKey(method, issuer)}|${weekend}|${istHour(at)}`
}

export class DegradationDetector {
  private readonly config: DetectorConfig
  private readonly cohorts = new Map<string, CohortStateRecord>()
  private readonly baselines = new Map<string, number>()
  private readonly baselineSamples = new Map<string, number>()

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config }
  }

  observe(
    at: number,
    method: PaymentMethod,
    issuer: string,
    succeeded: boolean,
    amountPaise: Paise,
  ): void {
    const key = cohortKey(method, issuer)
    const cohort = this.cohorts.get(key) ?? {
      method,
      issuer,
      attempts: [],
      cusum: 0,
      cusumRunStartedAt: undefined,
      onsetAt: undefined,
      degraded: false,
      suspect: false,
      consecutiveDegraded: 0,
    }

    cohort.attempts.push({ at, succeeded, amountPaise })
    this.cohorts.set(key, cohort)
    this.advanceCusum(cohort, at, succeeded, method, issuer)
  }

  private warmBaseline(key: string): number | undefined {
    const samples = this.baselineSamples.get(key) ?? 0
    if (samples < this.config.baselineWarmupWindows) return undefined
    return this.baselines.get(key)
  }

  private baselineFor(method: PaymentMethod, issuer: string, at: number): number | undefined {
    return (
      this.warmBaseline(seasonalKey(method, issuer, at)) ??
      this.warmBaseline(cohortKey(method, issuer))
    )
  }

  private advanceCusum(
    cohort: CohortStateRecord,
    at: number,
    succeeded: boolean,
    method: PaymentMethod,
    issuer: string,
  ): void {
    const baseline = this.baselineFor(method, issuer, at)
    if (baseline === undefined) return

    const expectedFailureRate = 1 - baseline
    const observation = succeeded ? 0 : 1
    const next = Math.max(
      0,
      cohort.cusum + (observation - expectedFailureRate - this.config.cusumSlack),
    )

    if (cohort.cusum === 0 && next > 0) cohort.cusumRunStartedAt = at
    if (next === 0) cohort.cusumRunStartedAt = undefined

    cohort.cusum = next

    if (next >= this.config.cusumThreshold && cohort.onsetAt === undefined) {
      cohort.onsetAt = cohort.cusumRunStartedAt ?? at
    }
  }

  tick(at: number): CohortHealth[] {
    const health = this.evaluate(at)
    this.learnBaselines(at)
    return health
  }

  learnBaselines(at: number): void {
    const windowStart = at - this.config.windowMs

    for (const cohort of this.cohorts.values()) {
      const window = cohort.attempts.filter(
        (attempt) => attempt.at >= windowStart && attempt.at <= at,
      )
      if (window.length < this.config.minVolume) continue
      if (cohort.suspect) continue

      const rate = window.filter((attempt) => attempt.succeeded).length / window.length

      for (const key of [
        seasonalKey(cohort.method, cohort.issuer, at),
        cohortKey(cohort.method, cohort.issuer),
      ]) {
        const previous = this.baselines.get(key)
        const updated =
          previous === undefined
            ? rate
            : previous * (1 - this.config.ewmaAlpha) + rate * this.config.ewmaAlpha

        this.baselines.set(key, updated)
        this.baselineSamples.set(key, (this.baselineSamples.get(key) ?? 0) + 1)
      }
    }
  }

  evaluate(at: number): CohortHealth[] {
    const windowStart = at - this.config.windowMs
    const results: CohortHealth[] = []

    for (const [key, cohort] of this.cohorts) {
      const window = cohort.attempts.filter(
        (attempt) => attempt.at >= windowStart && attempt.at <= at,
      )
      const attempts = window.length
      const successes = window.filter((attempt) => attempt.succeeded).length
      const observedRate = attempts === 0 ? 1 : successes / attempts
      const learned = this.baselineFor(cohort.method, cohort.issuer, at)
      const baseline = learned ?? observedRate
      const lcb = wilsonLowerBound(successes, attempts)

      const suppressedForBaseline = learned === undefined
      const suppressedForVolume = attempts < this.config.minVolume
      const dropPp = suppressedForBaseline ? 0 : baseline - observedRate
      const significantlyBelowBaseline =
        baseline > wilsonUpperBound(successes, attempts, this.config.significanceZ)

      const candidate =
        !suppressedForBaseline &&
        !suppressedForVolume &&
        significantlyBelowBaseline &&
        dropPp > this.config.dropThreshold

      cohort.suspect = candidate
      cohort.consecutiveDegraded = candidate ? cohort.consecutiveDegraded + 1 : 0
      const degraded = cohort.consecutiveDegraded >= this.config.consecutiveWindowsToAlert

      cohort.degraded = degraded
      if (!candidate) {
        cohort.onsetAt = undefined
        cohort.cusum = 0
        cohort.cusumRunStartedAt = undefined
      }

      const amountAtRisk = window
        .filter((attempt) => !attempt.succeeded)
        .reduce((total, attempt) => total + attempt.amountPaise, 0)

      results.push({
        key,
        method: cohort.method,
        issuer: cohort.issuer,
        attempts,
        successes,
        observedRate,
        wilsonLcb: lcb,
        baseline,
        dropPp,
        state: degraded ? 'DEGRADED' : 'HEALTHY',
        onsetAt: degraded ? cohort.onsetAt : undefined,
        amountAtRiskPaise: paise(amountAtRisk),
        suppressedForVolume,
        suppressedForBaseline,
      })
    }

    return results.sort((a, b) => b.dropPp - a.dropPp)
  }

  prune(before: number): void {
    for (const cohort of this.cohorts.values()) {
      cohort.attempts = cohort.attempts.filter((attempt) => attempt.at >= before)
    }
  }
}
