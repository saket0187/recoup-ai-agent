import { and, eq } from 'drizzle-orm'

import { paise, type Paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import {
  bootstrapDifferenceOfMeans,
  bootstrapStratifiedDifference,
  compareProportions,
  wilsonInterval,
  type Interval,
  type StratifiedSample,
  type ProportionComparison,
} from '../core/statistics'
import type { AuthorityConfig } from '../core/config-files'
import type { Arm } from '../domain/enums'
import type { Database } from '../db/client'
import { actions, contactEvents, decisions, diagnoses, riskCases } from '../db/schema'

const DAY_MS = 86_400_000

export interface ArmMetrics {
  readonly arm: Arm
  readonly cases: number
  readonly recovered: number
  readonly recoveryRate: Interval
  readonly billedPaise: Paise
  readonly recoveredPaise: Paise
  readonly recoveredPerCase: readonly number[]
  readonly recoveredFractionPerCase: readonly number[]
  readonly stratifiedRecoveredFraction: readonly StratifiedSample[]
  readonly netValuePerCase: readonly number[]
  readonly touches: number
  readonly retries: number
  readonly contactCostPaise: Paise
  readonly optOuts: number
  readonly overContactIncidents: number
  readonly falseDunningContacts: number
  readonly medianDaysToRecovery: number
  readonly p90DaysToRecovery: number
}

export interface MeasurementResult {
  readonly treatment: ArmMetrics
  readonly control: ArmMetrics
  readonly incrementalPerCasePaise: Interval
  readonly incrementalNetValuePerCasePaise: Interval
  readonly incrementalTotalPaise: Interval
  readonly incrementalRecoveredFraction: Interval
  readonly stratifiedRecoveredFraction: Interval
  readonly recoveryRateComparison: ProportionComparison
  readonly policyViolations: number
  readonly unmappedRate: number
  readonly propensityCoverage: number
  readonly decisionCount: number
  readonly deadLetteredActions: number
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
  return sorted[index] ?? 0
}

async function armMetrics(
  db: Database,
  merchantId: string,
  arm: Arm,
  authority: AuthorityConfig,
): Promise<ArmMetrics> {
  const cases = await db
    .select()
    .from(riskCases)
    .where(and(eq(riskCases.merchantId, merchantId), eq(riskCases.arm, arm)))

  const recovered = cases.filter((row) => row.state === 'RECOVERED')

  const [contacts, armActions] = await Promise.all([
    db
      .select({
        caseId: contactEvents.caseId,
        direction: contactEvents.direction,
        sentAt: contactEvents.sentAt,
        optOut: contactEvents.optOut,
      })
      .from(contactEvents)
      .innerJoin(riskCases, eq(contactEvents.caseId, riskCases.id))
      .where(and(eq(contactEvents.merchantId, merchantId), eq(riskCases.arm, arm))),
    db
      .select({
        caseId: actions.caseId,
        status: actions.status,
        costPaise: actions.costPaise,
      })
      .from(actions)
      .innerJoin(riskCases, eq(actions.caseId, riskCases.id))
      .where(and(eq(actions.merchantId, merchantId), eq(riskCases.arm, arm))),
  ])

  const resolvedAtByCase = new Map(cases.map((row) => [row.id, row.resolvedAt]))

  let falseDunning = 0
  for (const contact of contacts) {
    if (contact.direction !== 'OUTBOUND') continue
    const resolvedAt = resolvedAtByCase.get(contact.caseId)
    if (resolvedAt !== null && resolvedAt !== undefined && contact.sentAt > resolvedAt) {
      falseDunning++
    }
  }

  const touchCap = authority.budgets.max_touches_per_case
  const overContact = cases.filter((row) => row.touchCount > touchCap).length

  const daysToRecovery = recovered
    .map((row) => ((row.resolvedAt ?? row.firstSeenAt) - row.firstSeenAt) / DAY_MS)
    .sort((a, b) => a - b)

  const sentActions = armActions.filter((action) => action.status === 'SENT')
  const contactCost = sentActions.reduce((sum, action) => sum + action.costPaise, 0)

  const costByCase = new Map<string, number>()
  for (const action of sentActions) {
    costByCase.set(action.caseId, (costByCase.get(action.caseId) ?? 0) + action.costPaise)
  }

  return {
    arm,
    cases: cases.length,
    recovered: recovered.length,
    recoveryRate: wilsonInterval(recovered.length, cases.length),
    billedPaise: paise(cases.reduce((sum, row) => sum + row.amountPaise, 0)),
    recoveredPaise: paise(cases.reduce((sum, row) => sum + row.recoveredPaise, 0)),
    recoveredPerCase: cases.map((row) => row.recoveredPaise),
    recoveredFractionPerCase: cases.map((row) =>
      row.amountPaise === 0 ? 0 : Math.min(1, row.recoveredPaise / row.amountPaise),
    ),
    stratifiedRecoveredFraction: cases.map((row) => ({
      stratum: row.stratum,
      value: row.amountPaise === 0 ? 0 : Math.min(1, row.recoveredPaise / row.amountPaise),
    })),
    netValuePerCase: cases.map((row) => row.recoveredPaise - (costByCase.get(row.id) ?? 0)),
    touches: cases.reduce((sum, row) => sum + row.touchCount, 0),
    retries: cases.reduce((sum, row) => sum + row.attemptCount, 0),
    contactCostPaise: paise(contactCost),
    optOuts: contacts.filter((event) => event.optOut).length,
    overContactIncidents: overContact,
    falseDunningContacts: falseDunning,
    medianDaysToRecovery: percentile(daysToRecovery, 0.5),
    p90DaysToRecovery: percentile(daysToRecovery, 0.9),
  }
}

export async function measure(
  db: Database,
  merchantId: string,
  authority: AuthorityConfig,
  rng: Rng,
  bootstrapIterations = 1_000,
): Promise<MeasurementResult> {
  const treatment = await armMetrics(db, merchantId, 'TREATMENT', authority)
  const control = await armMetrics(db, merchantId, 'CONTROL', authority)

  const incrementalPerCase = bootstrapDifferenceOfMeans(
    treatment.recoveredPerCase,
    control.recoveredPerCase,
    rng,
    { iterations: bootstrapIterations },
  )

  const scale = treatment.cases
  const incrementalTotalPaise: Interval = {
    estimate: incrementalPerCase.estimate * scale,
    lower: incrementalPerCase.lower * scale,
    upper: incrementalPerCase.upper * scale,
  }

  const incrementalRecoveredFraction = bootstrapDifferenceOfMeans(
    treatment.recoveredFractionPerCase,
    control.recoveredFractionPerCase,
    rng,
    { iterations: bootstrapIterations },
  )

  const stratifiedRecoveredFraction = bootstrapStratifiedDifference(
    treatment.stratifiedRecoveredFraction,
    control.stratifiedRecoveredFraction,
    rng,
    { iterations: bootstrapIterations },
  )

  const incrementalNetValuePerCasePaise = bootstrapDifferenceOfMeans(
    treatment.netValuePerCase,
    control.netValuePerCase,
    rng,
    { iterations: bootstrapIterations },
  )

  const decisionRows = await db.select().from(decisions).where(eq(decisions.merchantId, merchantId))
  const diagnosisRows = await db.select().from(diagnoses)
  const actionRows = await db.select().from(actions).where(eq(actions.merchantId, merchantId))

  const sentByDecision = new Map<string, Set<string>>()
  for (const action of actionRows) {
    if (action.status !== 'SENT') continue
    const existing = sentByDecision.get(action.decisionId) ?? new Set<string>()
    existing.add(`${action.type}:${action.channel ?? ''}`)
    sentByDecision.set(action.decisionId, existing)
  }

  let policyViolations = 0
  for (const decision of decisionRows) {
    const sentActions = sentByDecision.get(decision.id)
    if (sentActions === undefined) continue

    const deniedAndSent = decision.policyEvaluations.some(
      (evaluation) =>
        evaluation.verdict === 'DENY' &&
        evaluation.action !== undefined &&
        sentActions.has(`${evaluation.action}:${evaluation.channel ?? ''}`),
    )
    if (deniedAndSent) policyViolations++
  }

  const withPropensity = decisionRows.filter(
    (decision) => decision.propensity > 0 && decision.propensity <= 1,
  ).length

  return {
    treatment,
    control,
    incrementalPerCasePaise: incrementalPerCase,
    incrementalNetValuePerCasePaise,
    incrementalTotalPaise,
    incrementalRecoveredFraction,
    stratifiedRecoveredFraction,
    recoveryRateComparison: compareProportions(
      treatment.recovered,
      treatment.cases,
      control.recovered,
      control.cases,
    ),
    policyViolations,
    unmappedRate:
      diagnosisRows.length === 0
        ? 0
        : diagnosisRows.filter((row) => row.failureClass === 'AMBIGUOUS').length /
          diagnosisRows.length,
    propensityCoverage: decisionRows.length === 0 ? 1 : withPropensity / decisionRows.length,
    decisionCount: decisionRows.length,
    deadLetteredActions: actionRows.filter((action) => action.status === 'DEAD_LETTER').length,
  }
}
