import { desc, eq, inArray } from 'drizzle-orm'

import { formatINR, paise, type Paise } from '../../../core/money'
import {
  actions,
  contactEvents,
  customers,
  decisions,
  diagnoses,
  ledgerEvents,
  riskCases,
} from '../../../db/schema'
import { consoleDb, MERCHANT_ID } from './connection'

export interface CaseRow {
  readonly id: string
  readonly state: string
  readonly arm: string
  readonly type: string
  readonly amountPaise: Paise
  readonly recoveredPaise: Paise
  readonly failureClass: string
  readonly cohortId: string | null
  readonly touchCount: number
  readonly attemptCount: number
  readonly firstSeenAt: number
  readonly resolvedAt: number | null
  readonly stopReason: string | null
}

export async function caseCount(): Promise<number> {
  const db = await consoleDb()
  const rows = await db
    .select({ id: riskCases.id })
    .from(riskCases)
    .where(eq(riskCases.merchantId, MERCHANT_ID))
  return rows.length
}

export async function caseList(limit = 300): Promise<CaseRow[]> {
  const db = await consoleDb()

  const rows = await db
    .select()
    .from(riskCases)
    .where(eq(riskCases.merchantId, MERCHANT_ID))
    .orderBy(desc(riskCases.firstSeenAt))
    .limit(limit)

  if (rows.length === 0) return []

  const diagnosisRows = await db
    .select({ caseId: diagnoses.caseId, failureClass: diagnoses.failureClass, at: diagnoses.at })
    .from(diagnoses)
    .where(
      inArray(
        diagnoses.caseId,
        rows.map((row) => row.id),
      ),
    )

  const latest = new Map<string, { failureClass: string; at: number }>()
  for (const row of diagnosisRows) {
    const seen = latest.get(row.caseId)
    if (seen === undefined || row.at >= seen.at) {
      latest.set(row.caseId, { failureClass: row.failureClass, at: row.at })
    }
  }

  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    arm: row.arm,
    type: row.type,
    amountPaise: paise(row.amountPaise),
    recoveredPaise: paise(row.recoveredPaise),
    failureClass: latest.get(row.id)?.failureClass ?? 'UNKNOWN',
    cohortId: row.cohortId,
    touchCount: row.touchCount,
    attemptCount: row.attemptCount,
    firstSeenAt: row.firstSeenAt,
    resolvedAt: row.resolvedAt,
    stopReason: row.stopReason,
  }))
}

export interface TimelineEntry {
  readonly at: number
  readonly kind: 'SIGNAL' | 'DIAGNOSIS' | 'DECISION' | 'ACTION' | 'CONTACT' | 'LEDGER'
  readonly headline: string
  readonly detail: string
  readonly tone: 'neutral' | 'good' | 'bad' | 'accent'
  readonly payload?: Record<string, unknown>
}

export interface CaseDetail {
  readonly row: CaseRow
  readonly customerRef: string
  readonly portfolio: string
  readonly outstandingPaise: Paise
  readonly timeline: readonly TimelineEntry[]
  readonly decisionCount: number
}

function toneOfVerdict(verdict: string): TimelineEntry['tone'] {
  if (verdict === 'EXECUTE') return 'accent'
  if (verdict === 'SUPPRESS') return 'bad'
  return 'neutral'
}

export async function caseDetail(caseId: string): Promise<CaseDetail | undefined> {
  const db = await consoleDb()

  const [row] = await db.select().from(riskCases).where(eq(riskCases.id, caseId)).limit(1)
  if (row === undefined) return undefined

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, row.customerId))
    .limit(1)

  const [diagnosisRows, decisionRows, actionRows, contactRows, ledgerRows] = await Promise.all([
    db.select().from(diagnoses).where(eq(diagnoses.caseId, caseId)),
    db.select().from(decisions).where(eq(decisions.caseId, caseId)).orderBy(decisions.at),
    db.select().from(actions).where(eq(actions.caseId, caseId)),
    db.select().from(contactEvents).where(eq(contactEvents.caseId, caseId)),
    db.select().from(ledgerEvents).where(eq(ledgerEvents.caseId, caseId)),
  ])

  const timeline: TimelineEntry[] = []

  for (const diagnosis of diagnosisRows) {
    timeline.push({
      at: diagnosis.at,
      kind: 'DIAGNOSIS',
      headline: diagnosis.failureClass,
      detail: `${diagnosis.method} · confidence ${(diagnosis.confidence * 100).toFixed(0)}%`,
      tone: diagnosis.failureClass === 'AMBIGUOUS' ? 'bad' : 'neutral',
    })
  }

  for (const decision of decisionRows) {
    timeline.push({
      at: decision.at,
      kind: 'DECISION',
      headline: `${decision.chosenAction}${decision.chosenChannel === null ? '' : ` · ${decision.chosenChannel}`}`,
      detail: `${decision.finalVerdict}${decision.suppressReason === null ? '' : ` · ${decision.suppressReason}`}`,
      tone: toneOfVerdict(decision.finalVerdict),
      payload: {
        propensity: decision.propensity,
        chosenBy: decision.chosenBy,
        policyVersion: decision.policyVersion,
        playbookVersion: decision.playbookVersion,
        candidates: decision.candidates,
        policyEvaluations: decision.policyEvaluations,
        stopEvaluations: decision.stopEvaluations,
        hash: decision.hash,
      },
    })
  }

  for (const action of actionRows) {
    timeline.push({
      at: action.scheduledFor,
      kind: 'ACTION',
      headline: `${action.type} ${action.status}`,
      detail: `${action.dryRun ? 'dry run · ' : ''}attempt ${action.attempts} · ${action.idempotencyKey.slice(0, 16)}`,
      tone: action.status === 'FAILED' || action.status === 'DEAD_LETTER' ? 'bad' : 'neutral',
    })
  }

  for (const contact of contactRows) {
    timeline.push({
      at: contact.sentAt,
      kind: 'CONTACT',
      headline: `${contact.direction} ${contact.channel}`,
      detail: contact.optOut ? 'opted out' : (contact.templateId ?? ''),
      tone: contact.optOut ? 'bad' : 'neutral',
    })
  }

  let outstanding = 0
  for (const entry of ledgerRows) {
    outstanding += entry.amountPaise
    timeline.push({
      at: entry.at,
      kind: 'LEDGER',
      headline: entry.type,
      detail: `${entry.amountPaise > 0 ? '+' : ''}${formatINR(paise(Math.abs(entry.amountPaise)))}`,
      tone: entry.amountPaise < 0 ? 'good' : 'neutral',
    })
  }

  timeline.sort((a, b) => a.at - b.at)

  return {
    row: {
      id: row.id,
      state: row.state,
      arm: row.arm,
      type: row.type,
      amountPaise: paise(row.amountPaise),
      recoveredPaise: paise(row.recoveredPaise),
      failureClass: diagnosisRows.at(-1)?.failureClass ?? 'UNKNOWN',
      cohortId: row.cohortId,
      touchCount: row.touchCount,
      attemptCount: row.attemptCount,
      firstSeenAt: row.firstSeenAt,
      resolvedAt: row.resolvedAt,
      stopReason: row.stopReason,
    },
    customerRef: customer?.externalRef ?? row.customerId,
    portfolio: customer?.portfolio ?? 'unknown',
    outstandingPaise: paise(Math.max(0, outstanding)),
    timeline,
    decisionCount: decisionRows.length,
  }
}
