import type { Rng } from './seeded-random'

export const DEFAULT_Z = 1.96

export interface Interval {
  readonly estimate: number
  readonly lower: number
  readonly upper: number
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const centre = mean(values)
  let sum = 0
  for (const value of values) sum += (value - centre) ** 2
  return Math.sqrt(sum / (values.length - 1))
}

export function wilsonInterval(successes: number, attempts: number, z = DEFAULT_Z): Interval {
  if (attempts === 0) return { estimate: 0, lower: 0, upper: 1 }

  const rate = successes / attempts
  const denominator = 1 + (z * z) / attempts
  const centre = rate + (z * z) / (2 * attempts)
  const margin = z * Math.sqrt((rate * (1 - rate)) / attempts + (z * z) / (4 * attempts * attempts))

  return {
    estimate: rate,
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
  }
}

export interface ProportionComparison {
  readonly treatmentRate: number
  readonly controlRate: number
  readonly difference: number
  readonly standardError: number
  readonly zScore: number
  readonly significantAt95: boolean
}

export function compareProportions(
  treatmentSuccesses: number,
  treatmentTotal: number,
  controlSuccesses: number,
  controlTotal: number,
): ProportionComparison {
  if (treatmentTotal === 0 || controlTotal === 0) {
    return {
      treatmentRate: 0,
      controlRate: 0,
      difference: 0,
      standardError: 0,
      zScore: 0,
      significantAt95: false,
    }
  }

  const treatmentRate = treatmentSuccesses / treatmentTotal
  const controlRate = controlSuccesses / controlTotal
  const pooled = (treatmentSuccesses + controlSuccesses) / (treatmentTotal + controlTotal)
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / treatmentTotal + 1 / controlTotal))
  const difference = treatmentRate - controlRate
  const zScore = standardError === 0 ? 0 : difference / standardError

  return {
    treatmentRate,
    controlRate,
    difference,
    standardError,
    zScore,
    significantAt95: Math.abs(zScore) > DEFAULT_Z,
  }
}

function resampleMean(values: readonly number[], rng: Rng): number {
  let total = 0
  for (let i = 0; i < values.length; i++) {
    total += values[rng.int(0, values.length)] ?? 0
  }
  return total / values.length
}

export interface BootstrapOptions {
  readonly iterations?: number
  readonly confidence?: number
}

export function bootstrapDifferenceOfMeans(
  treatment: readonly number[],
  control: readonly number[],
  rng: Rng,
  options: BootstrapOptions = {},
): Interval {
  const iterations = options.iterations ?? 1_000
  const confidence = options.confidence ?? 0.95

  if (treatment.length === 0 || control.length === 0) {
    return { estimate: 0, lower: 0, upper: 0 }
  }

  const estimate = mean(treatment) - mean(control)
  const draws: number[] = []

  for (let i = 0; i < iterations; i++) {
    draws.push(resampleMean(treatment, rng) - resampleMean(control, rng))
  }

  draws.sort((a, b) => a - b)

  const tail = (1 - confidence) / 2
  const lowerIndex = Math.max(0, Math.floor(tail * (draws.length - 1)))
  const upperIndex = Math.min(draws.length - 1, Math.ceil((1 - tail) * (draws.length - 1)))

  return {
    estimate,
    lower: draws[lowerIndex] ?? estimate,
    upper: draws[upperIndex] ?? estimate,
  }
}

export function excludesZero(interval: Interval): boolean {
  return (interval.lower > 0 && interval.upper > 0) || (interval.lower < 0 && interval.upper < 0)
}

export interface StratifiedSample {
  readonly stratum: string
  readonly value: number
}

function stratifiedDifference(
  treatment: readonly StratifiedSample[],
  control: readonly StratifiedSample[],
): number {
  const byStratum = new Map<string, { t: number[]; c: number[] }>()
  for (const row of treatment) {
    const entry = byStratum.get(row.stratum) ?? { t: [], c: [] }
    entry.t.push(row.value)
    byStratum.set(row.stratum, entry)
  }
  for (const row of control) {
    const entry = byStratum.get(row.stratum) ?? { t: [], c: [] }
    entry.c.push(row.value)
    byStratum.set(row.stratum, entry)
  }

  let weighted = 0
  let totalWeight = 0
  for (const entry of byStratum.values()) {
    if (entry.t.length === 0 || entry.c.length === 0) continue
    const weight = entry.t.length + entry.c.length
    weighted += weight * (mean(entry.t) - mean(entry.c))
    totalWeight += weight
  }

  return totalWeight === 0 ? 0 : weighted / totalWeight
}

function resampleStratified(
  samples: readonly StratifiedSample[],
  rng: Rng,
): readonly StratifiedSample[] {
  const drawn: StratifiedSample[] = []
  for (let i = 0; i < samples.length; i++) {
    const picked = samples[Math.floor(rng.next() * samples.length)]
    if (picked !== undefined) drawn.push(picked)
  }
  return drawn
}

export function bootstrapStratifiedDifference(
  treatment: readonly StratifiedSample[],
  control: readonly StratifiedSample[],
  rng: Rng,
  options: BootstrapOptions = {},
): Interval {
  const iterations = options.iterations ?? 1_000
  const confidence = options.confidence ?? 0.95

  if (treatment.length === 0 || control.length === 0) {
    return { estimate: 0, lower: 0, upper: 0 }
  }

  const estimate = stratifiedDifference(treatment, control)
  const draws: number[] = []

  for (let i = 0; i < iterations; i++) {
    draws.push(
      stratifiedDifference(resampleStratified(treatment, rng), resampleStratified(control, rng)),
    )
  }

  draws.sort((a, b) => a - b)

  const tail = (1 - confidence) / 2
  const lowerIndex = Math.max(0, Math.floor(tail * (draws.length - 1)))
  const upperIndex = Math.min(draws.length - 1, Math.ceil((1 - tail) * (draws.length - 1)))

  return {
    estimate,
    lower: draws[lowerIndex] ?? estimate,
    upper: draws[upperIndex] ?? estimate,
  }
}
