import { and, desc, eq, inArray } from 'drizzle-orm'

import { paise, type Paise } from '../../../core/money'
import { actions, decisions, riskCases } from '../../../db/schema'
import { consoleDb, MERCHANT_ID } from './connection'

export interface ExceptionRow {
  readonly caseId: string
  readonly at: number
  readonly action: string
  readonly reason: string
  readonly detail: string
  readonly amountPaise: Paise
  readonly kind: 'ESCALATION' | 'STOPPED' | 'DEAD_LETTER'
}

export async function exceptions(limit = 200): Promise<ExceptionRow[]> {
  const db = await consoleDb()

  const [escalations, stopped, dead] = await Promise.all([
    db
      .select()
      .from(decisions)
      .where(eq(decisions.chosenAction, 'ESCALATE_HUMAN'))
      .orderBy(desc(decisions.at))
      .limit(limit),
    db
      .select()
      .from(riskCases)
      .where(and(eq(riskCases.merchantId, MERCHANT_ID), eq(riskCases.state, 'STOPPED')))
      .orderBy(desc(riskCases.updatedAt))
      .limit(limit),
    db
      .select()
      .from(actions)
      .where(eq(actions.status, 'DEAD_LETTER'))
      .orderBy(desc(actions.scheduledFor))
      .limit(limit),
  ])

  const referenced = [
    ...new Set([...escalations.map((row) => row.caseId), ...dead.map((row) => row.caseId)]),
  ]

  const amounts = new Map<string, number>()
  if (referenced.length > 0) {
    const rows = await db
      .select({ id: riskCases.id, amountPaise: riskCases.amountPaise })
      .from(riskCases)
      .where(inArray(riskCases.id, referenced))
    for (const row of rows) amounts.set(row.id, row.amountPaise)
  }

  const rows: ExceptionRow[] = []

  for (const decision of escalations) {
    rows.push({
      caseId: decision.caseId,
      at: decision.at,
      action: 'ESCALATE_HUMAN',
      reason: decision.suppressReason ?? 'bounded authority exceeded',
      detail: `${decision.finalVerdict} · propensity ${decision.propensity.toFixed(3)}`,
      amountPaise: paise(amounts.get(decision.caseId) ?? 0),
      kind: 'ESCALATION',
    })
  }

  for (const row of stopped) {
    rows.push({
      caseId: row.id,
      at: row.updatedAt,
      action: 'STOP',
      reason: row.stopReason ?? 'stopped',
      detail: `${row.touchCount} touches · ${row.attemptCount} attempts`,
      amountPaise: paise(row.amountPaise),
      kind: 'STOPPED',
    })
  }

  for (const action of dead) {
    rows.push({
      caseId: action.caseId,
      at: action.scheduledFor,
      action: action.type,
      reason: action.lastError ?? 'dead lettered',
      detail: `${action.attempts} attempts`,
      amountPaise: paise(amounts.get(action.caseId) ?? 0),
      kind: 'DEAD_LETTER',
    })
  }

  return rows.sort((a, b) => b.at - a.at).slice(0, limit)
}
