import { eq } from 'drizzle-orm'

import { cohorts, riskCases } from '../../../db/schema'
import { consoleDb, MERCHANT_ID } from './connection'

export interface CohortCell {
  readonly cohortId: string
  readonly method: string
  readonly issuer: string
  readonly attempts: number
  readonly failures: number
  readonly failureRate: number
  readonly cases: number
  readonly recovered: number
  readonly state: 'healthy' | 'degraded' | 'paused'
  readonly everDegraded: boolean
  readonly degradedWindows: number
  readonly worstLcb: number
  readonly wilsonLcb: number
  readonly baseline: number
  readonly since: number
  readonly series: readonly number[]
}

const MAX_COHORT_WINDOWS = 20_000
const MAX_SCAN_ROWS = 20_000

export async function cohortHealth(): Promise<CohortCell[]> {
  const db = await consoleDb()

  const [windows, cases] = await Promise.all([
    db
      .select()
      .from(cohorts)
      .where(eq(cohorts.merchantId, MERCHANT_ID))
      .orderBy(cohorts.windowStart)
      .limit(MAX_COHORT_WINDOWS),
    db
      .select({ cohortId: riskCases.cohortId, state: riskCases.state })
      .from(riskCases)
      .where(eq(riskCases.merchantId, MERCHANT_ID))
      .limit(MAX_SCAN_ROWS),
  ])

  const caseStats = new Map<string, { cases: number; recovered: number }>()
  for (const row of cases) {
    const key = row.cohortId ?? 'unknown|unknown'
    const entry = caseStats.get(key) ?? { cases: 0, recovered: 0 }
    entry.cases++
    if (row.state === 'RECOVERED') entry.recovered++
    caseStats.set(key, entry)
  }

  const byKey = new Map<string, typeof windows>()
  for (const window of windows) {
    const list = byKey.get(window.key) ?? []
    list.push(window)
    byKey.set(window.key, list)
  }

  const cells: CohortCell[] = []
  for (const [key, list] of byKey) {
    const ordered = [...list].sort((a, b) => a.windowStart - b.windowStart)
    const latest = ordered.at(-1)
    if (latest === undefined) continue

    const attempts = ordered.reduce((sum, window) => sum + window.attempts, 0)
    const successes = ordered.reduce((sum, window) => sum + window.successes, 0)
    const stats = caseStats.get(key) ?? { cases: 0, recovered: 0 }
    const degradedWindows = ordered.filter((window) => window.state === 'DEGRADED')
    const firstDegraded = degradedWindows[0]

    cells.push({
      cohortId: key,
      method: latest.method,
      issuer: latest.issuer ?? 'any',
      attempts,
      failures: attempts - successes,
      failureRate: attempts === 0 ? 0 : (attempts - successes) / attempts,
      cases: stats.cases,
      recovered: stats.recovered,
      state:
        latest.state === 'PAUSED' || latest.state === 'CANARY'
          ? 'paused'
          : latest.state === 'DEGRADED'
            ? 'degraded'
            : 'healthy',
      everDegraded: degradedWindows.length > 0,
      degradedWindows: degradedWindows.length,
      worstLcb: Math.min(...ordered.map((window) => window.wilsonLcb)),
      wilsonLcb: latest.wilsonLcb,
      baseline: latest.baselineEwma,
      since: firstDegraded?.since ?? latest.since,
      series: ordered.slice(-24).map((window) => window.wilsonLcb),
    })
  }

  return cells.sort((a, b) => b.attempts - a.attempts)
}
