import { paise, type Paise } from '../core/money'

export interface CellObservation {
  readonly dims: Readonly<Record<string, string>>
  readonly attempts: number
  readonly successes: number
  readonly baselineRate: number
  readonly amountAtRiskPaise: Paise
}

export interface AttributedCell {
  readonly dims: Readonly<Record<string, string>>
  readonly attempts: number
  readonly expectedSuccesses: number
  readonly actualSuccesses: number
  readonly deficit: number
  readonly shareOfDeficit: number
  readonly amountAtRiskPaise: Paise
}

export interface Attribution {
  readonly cells: readonly AttributedCell[]
  readonly totalDeficit: number
  readonly explainedFraction: number
  readonly amountAtRiskPaise: Paise
}

export interface AttributionOptions {
  readonly maxCells?: number
  readonly residualThreshold?: number
  readonly rollUpTolerance?: number
}

const DEFAULTS = { maxCells: 3, residualThreshold: 0.1, rollUpTolerance: 0.95 } as const

const HEALTHY_EPSILON = 0.5

function deficitOf(observation: CellObservation): number {
  return Math.max(0, observation.baselineRate * observation.attempts - observation.successes)
}

function patternsFor(
  dims: Readonly<Record<string, string>>,
  dimensions: readonly string[],
): string[] {
  const patterns: string[] = []
  const total = 1 << dimensions.length

  for (let mask = 0; mask < total; mask++) {
    const parts: string[] = []
    for (const [index, dimension] of dimensions.entries()) {
      const value = (mask & (1 << index)) === 0 ? '*' : (dims[dimension] ?? '*')
      parts.push(`${dimension}=${value}`)
    }
    patterns.push(parts.join('&'))
  }

  return patterns
}

function patternMatches(
  pattern: string,
  dims: Readonly<Record<string, string>>,
  dimensions: readonly string[],
): boolean {
  const fixed = decodePattern(pattern, dimensions)
  for (const [dimension, value] of Object.entries(fixed)) {
    if (dims[dimension] !== value) return false
  }
  return true
}

function decodePattern(pattern: string, dimensions: readonly string[]): Record<string, string> {
  const fixed: Record<string, string> = {}
  for (const part of pattern.split('&')) {
    const [dimension, value] = part.split('=')
    if (dimension === undefined || value === undefined || value === '*') continue
    if (!dimensions.includes(dimension)) continue
    fixed[dimension] = value
  }
  return fixed
}

function specificity(pattern: string): number {
  return pattern.split('&').filter((part) => !part.endsWith('=*')).length
}

export function attributeRootCause(
  observations: readonly CellObservation[],
  dimensions: readonly string[],
  options: AttributionOptions = {},
): Attribution {
  const maxCells = options.maxCells ?? DEFAULTS.maxCells
  const residualThreshold = options.residualThreshold ?? DEFAULTS.residualThreshold
  const rollUpTolerance = options.rollUpTolerance ?? DEFAULTS.rollUpTolerance

  const totalDeficit = observations.reduce((sum, observation) => sum + deficitOf(observation), 0)

  if (totalDeficit <= 0) {
    return { cells: [], totalDeficit: 0, explainedFraction: 1, amountAtRiskPaise: paise(0) }
  }

  const candidates = new Set<string>()
  for (const observation of observations) {
    for (const pattern of patternsFor(observation.dims, dimensions)) candidates.add(pattern)
  }

  const remaining = new Set(observations)
  const chosen: AttributedCell[] = []
  let explained = 0

  while (chosen.length < maxCells) {
    const residual = totalDeficit - explained
    if (residual / totalDeficit < residualThreshold) break

    const scored = [...candidates]
      .sort()
      .map((pattern) => {
        let deficit = 0
        let coversHealthy = false
        for (const observation of remaining) {
          if (!patternMatches(pattern, observation.dims, dimensions)) continue
          const cellDeficit = deficitOf(observation)
          deficit += cellDeficit
          if (cellDeficit < HEALTHY_EPSILON) coversHealthy = true
        }
        return { pattern, deficit, coversHealthy, specificity: specificity(pattern) }
      })
      .filter((candidate) => candidate.deficit > 0)

    const focused = scored.filter((candidate) => !candidate.coversHealthy)
    const pool = focused.length > 0 ? focused : scored
    if (pool.length === 0) break

    const best = pool.reduce((leader, candidate) =>
      candidate.deficit > leader.deficit ? candidate : leader,
    )

    const selected = pool
      .filter((candidate) => candidate.deficit >= best.deficit * rollUpTolerance)
      .reduce((leader, candidate) =>
        candidate.specificity < leader.specificity ? candidate : leader,
      )

    const matched = [...remaining].filter((observation) =>
      patternMatches(selected.pattern, observation.dims, dimensions),
    )

    const attempts = matched.reduce((sum, observation) => sum + observation.attempts, 0)
    const actual = matched.reduce((sum, observation) => sum + observation.successes, 0)
    const expected = matched.reduce(
      (sum, observation) => sum + observation.baselineRate * observation.attempts,
      0,
    )
    const amountAtRisk = matched.reduce(
      (sum, observation) => sum + observation.amountAtRiskPaise,
      0,
    )

    chosen.push({
      dims: decodePattern(selected.pattern, dimensions),
      attempts,
      expectedSuccesses: expected,
      actualSuccesses: actual,
      deficit: selected.deficit,
      shareOfDeficit: selected.deficit / totalDeficit,
      amountAtRiskPaise: paise(amountAtRisk),
    })

    explained += selected.deficit
    for (const observation of matched) remaining.delete(observation)
  }

  const amountAtRisk = chosen.reduce((sum, cell) => sum + cell.amountAtRiskPaise, 0)

  return {
    cells: chosen,
    totalDeficit,
    explainedFraction: explained / totalDeficit,
    amountAtRiskPaise: paise(amountAtRisk),
  }
}

export function describeAttribution(attribution: Attribution): string {
  if (attribution.cells.length === 0) return 'no deviation to explain'

  const parts = attribution.cells.map((cell) => {
    const dims = Object.entries(cell.dims)
      .map(([dimension, value]) => `${dimension}=${value}`)
      .join(', ')
    return `${dims === '' ? 'all traffic' : dims} (${(cell.shareOfDeficit * 100).toFixed(0)}%)`
  })

  return `${parts.join('; ')} (${(attribution.explainedFraction * 100).toFixed(0)}% of the deviation explained)`
}
