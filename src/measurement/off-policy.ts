import type { Rng } from '../core/seeded-random'
import type { Interval } from '../core/statistics'

export interface LoggedDecision {
  readonly caseId: string
  readonly stratum: string
  readonly action: string
  readonly propensity: number
  readonly reward: number
}

export type TargetPolicy = (row: LoggedDecision) => string

export interface OffPolicyEstimate {
  readonly policy: string
  readonly ips: Interval
  readonly snips: Interval
  readonly doublyRobust: Interval
  readonly effectiveSampleSize: number
  readonly overlap: number
  readonly clipped: number
  readonly rows: number
}

const DEFAULT_CLIP = 20
const DEFAULT_FOLDS = 5

function directMethod(rows: readonly LoggedDecision[]): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>()
  for (const row of rows) {
    const key = `${row.stratum}|${row.action}`
    const entry = sums.get(key) ?? { total: 0, count: 0 }
    entry.total += row.reward
    entry.count += 1
    sums.set(key, entry)
  }

  const means = new Map<string, number>()
  for (const [key, entry] of sums) means.set(key, entry.total / entry.count)
  return means
}

function clustersOf(rows: readonly LoggedDecision[]): LoggedDecision[][] {
  const byCase = new Map<string, LoggedDecision[]>()
  for (const row of rows) {
    const bucket = byCase.get(row.caseId)
    if (bucket === undefined) byCase.set(row.caseId, [row])
    else bucket.push(row)
  }
  return [...byCase.values()]
}

function crossFitBaselines(rows: readonly LoggedDecision[], folds: number): Map<string, number>[] {
  const clusters = clustersOf(rows)
  const assigned = clusters.map((cluster, index) => ({ cluster, fold: index % folds }))
  return Array.from({ length: folds }, (_, fold) =>
    directMethod(assigned.filter((entry) => entry.fold !== fold).flatMap((entry) => entry.cluster)),
  )
}

interface PointEstimates {
  readonly ips: number
  readonly snips: number
  readonly doublyRobust: number
  readonly weightSum: number
  readonly weightSquareSum: number
  readonly matched: number
  readonly clipped: number
}

function estimate(
  rows: readonly LoggedDecision[],
  policy: TargetPolicy,
  baselines: readonly ReadonlyMap<string, number>[],
  clip: number,
): PointEstimates {
  let ipsSum = 0
  let weightSum = 0
  let weightSquareSum = 0
  let drSum = 0
  let matched = 0
  let clipped = 0

  for (const [index, row] of rows.entries()) {
    const target = policy(row)
    const predicted = baselines[index]?.get(`${row.stratum}|${target}`) ?? 0

    if (target !== row.action) {
      drSum += predicted
      continue
    }

    matched += 1
    const raw = 1 / row.propensity
    const weight = Math.min(raw, clip)
    if (raw > clip) clipped += 1

    ipsSum += weight * row.reward
    weightSum += weight
    weightSquareSum += weight * weight
    drSum += predicted + weight * (row.reward - predicted)
  }

  const n = rows.length
  return {
    ips: n === 0 ? 0 : ipsSum / n,
    snips: weightSum === 0 ? 0 : ipsSum / weightSum,
    doublyRobust: n === 0 ? 0 : drSum / n,
    weightSum,
    weightSquareSum,
    matched,
    clipped,
  }
}

function percentileInterval(draws: number[], point: number, confidence = 0.95): Interval {
  if (draws.length === 0) return { estimate: point, lower: point, upper: point }
  draws.sort((a, b) => a - b)
  const tail = (1 - confidence) / 2
  const lower = Math.max(0, Math.floor(tail * (draws.length - 1)))
  const upper = Math.min(draws.length - 1, Math.ceil((1 - tail) * (draws.length - 1)))
  return { estimate: point, lower: draws[lower] ?? point, upper: draws[upper] ?? point }
}

export function evaluatePolicy(
  rows: readonly LoggedDecision[],
  name: string,
  policy: TargetPolicy,
  rng: Rng,
  options: { iterations?: number; clip?: number; folds?: number } = {},
): OffPolicyEstimate {
  const iterations = options.iterations ?? 400
  const clip = options.clip ?? DEFAULT_CLIP

  if (rows.length === 0) {
    const zero: Interval = { estimate: 0, lower: 0, upper: 0 }
    return {
      policy: name,
      ips: zero,
      snips: zero,
      doublyRobust: zero,
      effectiveSampleSize: 0,
      overlap: 0,
      clipped: 0,
      rows: 0,
    }
  }

  const folds = options.folds ?? DEFAULT_FOLDS
  const clusters = clustersOf(rows)
  const foldBaselines = crossFitBaselines(rows, Math.min(folds, Math.max(2, clusters.length)))
  const baselineFor = (index: number): ReadonlyMap<string, number> =>
    foldBaselines[index % foldBaselines.length] ?? new Map<string, number>()

  const pointRows: LoggedDecision[] = []
  const pointBaselines: ReadonlyMap<string, number>[] = []
  clusters.forEach((cluster, index) => {
    for (const row of cluster) {
      pointRows.push(row)
      pointBaselines.push(baselineFor(index))
    }
  })

  const point = estimate(pointRows, policy, pointBaselines, clip)

  const ipsDraws: number[] = []
  const snipsDraws: number[] = []
  const drDraws: number[] = []

  for (let i = 0; i < iterations; i++) {
    const resampled: LoggedDecision[] = []
    const resampledBaselines: ReadonlyMap<string, number>[] = []
    for (let j = 0; j < clusters.length; j++) {
      const pickedIndex = Math.floor(rng.next() * clusters.length)
      const picked = clusters[pickedIndex]
      if (picked === undefined) continue
      for (const row of picked) {
        resampled.push(row)
        resampledBaselines.push(baselineFor(pickedIndex))
      }
    }
    const draw = estimate(resampled, policy, resampledBaselines, clip)
    ipsDraws.push(draw.ips)
    snipsDraws.push(draw.snips)
    drDraws.push(draw.doublyRobust)
  }

  return {
    policy: name,
    ips: percentileInterval(ipsDraws, point.ips),
    snips: percentileInterval(snipsDraws, point.snips),
    doublyRobust: percentileInterval(drDraws, point.doublyRobust),
    effectiveSampleSize:
      point.weightSquareSum === 0 ? 0 : (point.weightSum * point.weightSum) / point.weightSquareSum,
    overlap: point.matched / rows.length,
    clipped: point.clipped,
    rows: rows.length,
  }
}
