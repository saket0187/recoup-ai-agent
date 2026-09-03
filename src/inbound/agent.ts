import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { AuthorityConfig } from '../core/config-files'
import type { Clock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import type { Logger } from '../core/logger'
import type { Database } from '../db/client'
import { contactEvents, promises, riskCases } from '../db/schema'
import type { InboundIntent } from '../domain/enums'
import { extractIntent } from './intent'

const DAY_MS = 86_400_000

export interface InboundOptions {
  readonly db: Database
  readonly clock: Clock
  readonly ids: IdFactory
  readonly logger: Logger
  readonly authority: AuthorityConfig
}

export interface InboundStats {
  readonly processed: number
  readonly promisesRecorded: number
  readonly disputesOpened: number
  readonly optOuts: number
  readonly escalated: number
  readonly byIntent: Readonly<Partial<Record<InboundIntent, number>>>
}

export class InboundAgent {
  private readonly options: InboundOptions

  constructor(options: InboundOptions) {
    this.options = options
  }

  async process(at: number): Promise<InboundStats> {
    const pending = await this.options.db
      .select()
      .from(contactEvents)
      .where(and(eq(contactEvents.direction, 'INBOUND'), isNull(contactEvents.intent)))

    if (pending.length === 0) {
      return {
        processed: 0,
        promisesRecorded: 0,
        disputesOpened: 0,
        optOuts: 0,
        escalated: 0,
        byIntent: {},
      }
    }

    const caseIds = [...new Set(pending.map((event) => event.caseId))]
    const caseRows = await this.options.db
      .select()
      .from(riskCases)
      .where(inArray(riskCases.id, caseIds))
    const caseById = new Map(caseRows.map((row) => [row.id, row]))

    const promiseRows = await this.options.db
      .select({ caseId: promises.caseId })
      .from(promises)
      .where(and(inArray(promises.caseId, caseIds), eq(promises.status, 'ACTIVE')))
    const activePromises = new Map<string, number>()
    for (const row of promiseRows) {
      activePromises.set(row.caseId, (activePromises.get(row.caseId) ?? 0) + 1)
    }

    const byIntent: Partial<Record<InboundIntent, number>> = {}
    let promisesRecorded = 0
    let disputesOpened = 0
    let optOuts = 0
    let escalated = 0

    for (const event of pending) {
      const body = event.body ?? ''
      const extracted = extractIntent(body)
      byIntent[extracted.intent] = (byIntent[extracted.intent] ?? 0) + 1

      await this.options.db
        .update(contactEvents)
        .set({ intent: extracted.intent })
        .where(eq(contactEvents.id, event.id))

      const riskCase = caseById.get(event.caseId)
      if (riskCase === undefined) continue

      this.options.logger.info('inbound_intent', {
        caseId: event.caseId,
        intent: extracted.intent,
        confidence: extracted.confidence,
      })

      switch (extracted.intent) {
        case 'PROMISE_TO_PAY': {
          const active = activePromises.get(event.caseId) ?? 0
          if (active >= this.options.authority.budgets.max_ptp_per_case) break
          activePromises.set(event.caseId, active + 1)

          const days = extracted.promisedInDays ?? 7
          await this.options.db.insert(promises).values({
            id: this.options.ids.next('promise'),
            caseId: event.caseId,
            amountPaise: riskCase.amountPaise,
            promisedDate: at + days * DAY_MS,
            source: 'TEXT',
            confidence: extracted.confidence,
            status: 'ACTIVE',
            supersededBy: null,
            createdAt: at,
            resolvedAt: null,
          })
          promisesRecorded++
          break
        }

        case 'DISPUTE_AMOUNT':
        case 'DISPUTE_SERVICE': {
          if (riskCase.disputeOpenedAt === null) {
            await this.options.db
              .update(riskCases)
              .set({ disputeOpenedAt: at, updatedAt: at })
              .where(eq(riskCases.id, event.caseId))
            caseById.set(event.caseId, { ...riskCase, disputeOpenedAt: at })
            disputesOpened++
          }
          break
        }

        case 'DISTRESS':
        case 'ABUSE':
        case 'WRONG_PERSON':
        case 'REQUEST_HUMAN': {
          await this.options.db
            .update(riskCases)
            .set({ state: 'AWAITING_HUMAN', updatedAt: at })
            .where(eq(riskCases.id, event.caseId))
          escalated++
          break
        }

        case 'OPT_OUT': {
          optOuts++
          break
        }

        case 'WILL_PAY_NOW':
        case 'ALREADY_PAID':
        case 'CANNOT_PAY':
        case 'REQUEST_PLAN':
        case 'UNCLEAR':
          break
      }
    }

    return {
      processed: pending.length,
      promisesRecorded,
      disputesOpened,
      optOuts,
      escalated,
      byIntent,
    }
  }

  async expirePromises(at: number): Promise<number> {
    const active = await this.options.db
      .select()
      .from(promises)
      .where(eq(promises.status, 'ACTIVE'))

    const due = active.filter((promise) => promise.promisedDate < at)
    if (due.length === 0) return 0

    const settled = await this.options.db
      .select({
        id: riskCases.id,
        state: riskCases.state,
        recoveredPaise: riskCases.recoveredPaise,
      })
      .from(riskCases)
      .where(inArray(riskCases.id, [...new Set(due.map((promise) => promise.caseId))]))
    const settledById = new Map(settled.map((row) => [row.id, row]))

    let broken = 0
    for (const promise of due) {
      const riskCase = settledById.get(promise.caseId)
      const kept = riskCase?.state === 'RECOVERED' || (riskCase?.recoveredPaise ?? 0) > 0

      await this.options.db
        .update(promises)
        .set({ status: kept ? 'KEPT' : 'BROKEN', resolvedAt: at })
        .where(eq(promises.id, promise.id))

      if (!kept) broken++
    }

    return broken
  }
}
