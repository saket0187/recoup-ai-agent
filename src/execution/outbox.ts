import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'

import type { Clock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import type { Paise } from '../core/money'
import type { ActionType, Channel, Language } from '../domain/enums'
import type { Database } from '../db/client'
import { actions, type ActionRow } from '../db/schema'

export interface EnqueueRequest {
  readonly decisionId: string
  readonly caseId: string
  readonly type: ActionType
  readonly channel: Channel | undefined
  readonly templateId: string | undefined
  readonly language: Language | undefined
  readonly amountPaise: Paise | undefined
  readonly scheduledFor: number
  readonly merchantId: string
  readonly idempotencyKey: string
  readonly bestRemainingEvPaise: number
  readonly dryRun: boolean
}

export interface EnqueueResult {
  readonly actionId: string
  readonly duplicate: boolean
}

const CLAIMABLE = ['SCHEDULED'] as const

export class Outbox {
  private readonly db: Database
  private readonly clock: Clock
  private readonly ids: IdFactory

  constructor(db: Database, clock: Clock, ids: IdFactory) {
    this.db = db
    this.clock = clock
    this.ids = ids
  }

  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const id = this.ids.next('action')
    const inserted = await this.db
      .insert(actions)
      .values({
        id,
        merchantId: request.merchantId,
        decisionId: request.decisionId,
        caseId: request.caseId,
        type: request.type,
        channel: request.channel ?? null,
        templateId: request.templateId ?? null,
        language: request.language ?? null,
        amountPaise: request.amountPaise ?? null,
        scheduledFor: request.scheduledFor,
        idempotencyKey: request.idempotencyKey,
        bestRemainingEvPaise: request.bestRemainingEvPaise,
        status: 'SCHEDULED',
        attempts: 0,
        providerRef: null,
        costPaise: 0,
        dryRun: request.dryRun,
        lastError: null,
        executedAt: null,
        createdAt: this.clock.now(),
      })
      .onConflictDoNothing({ target: actions.idempotencyKey })
      .returning({ id: actions.id })

    const row = inserted[0]
    if (row !== undefined) return { actionId: row.id, duplicate: false }

    const existing = await this.db
      .select({ id: actions.id })
      .from(actions)
      .where(eq(actions.idempotencyKey, request.idempotencyKey))
      .limit(1)

    const found = existing[0]
    if (found === undefined) {
      throw new Error(
        `outbox: insert for ${request.idempotencyKey} conflicted but no existing row was found`,
      )
    }
    return { actionId: found.id, duplicate: true }
  }

  async due(at: number, limit = 500): Promise<ActionRow[]> {
    return this.db
      .select()
      .from(actions)
      .where(and(inArray(actions.status, CLAIMABLE), lte(actions.scheduledFor, at)))
      .orderBy(asc(actions.scheduledFor), asc(actions.id))
      .limit(limit)
  }

  async claim(actionId: string): Promise<boolean> {
    const claimed = await this.db
      .update(actions)
      .set({ status: 'IN_FLIGHT' })
      .where(and(eq(actions.id, actionId), eq(actions.status, 'SCHEDULED')))
      .returning({ id: actions.id })

    return claimed.length === 1
  }

  async markSent(
    actionId: string,
    providerRef: string | undefined,
    costPaise: Paise,
    at: number,
  ): Promise<void> {
    await this.db
      .update(actions)
      .set({
        status: 'SENT',
        providerRef: providerRef ?? null,
        costPaise,
        executedAt: at,
        attempts: sql`${actions.attempts} + 1`,
      })
      .where(eq(actions.id, actionId))
  }

  async markSuppressed(actionId: string, reason: string, at: number): Promise<void> {
    await this.db
      .update(actions)
      .set({ status: 'SUPPRESSED', lastError: reason, executedAt: at })
      .where(eq(actions.id, actionId))
  }

  async reschedule(actionId: string, at: number, reason: string): Promise<void> {
    await this.db
      .update(actions)
      .set({ status: 'SCHEDULED', scheduledFor: at, lastError: reason })
      .where(eq(actions.id, actionId))
  }

  async markRetry(actionId: string, at: number, error: string): Promise<void> {
    await this.db
      .update(actions)
      .set({
        status: 'SCHEDULED',
        scheduledFor: at,
        lastError: error,
        attempts: sql`${actions.attempts} + 1`,
      })
      .where(eq(actions.id, actionId))
  }

  async deadLetter(actionId: string, error: string, at: number): Promise<void> {
    await this.db
      .update(actions)
      .set({
        status: 'DEAD_LETTER',
        lastError: error,
        executedAt: at,
        attempts: sql`${actions.attempts} + 1`,
      })
      .where(eq(actions.id, actionId))
  }

  async cancelPendingForCase(caseId: string, reason: string): Promise<number> {
    const cancelled = await this.db
      .update(actions)
      .set({ status: 'CANCELLED', lastError: reason })
      .where(and(eq(actions.caseId, caseId), inArray(actions.status, CLAIMABLE)))
      .returning({ id: actions.id })

    return cancelled.length
  }
}
