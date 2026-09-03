import { eq } from 'drizzle-orm'

import type { AuthorityConfig } from '../core/config-files'
import { sha256 } from '../core/canonical-hash'
import type { Clock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import { KeyedMutex } from '../core/keyed-mutex'
import type { Logger } from '../core/logger'
import { paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import type { Channel, StopReason } from '../domain/enums'
import type { Database } from '../db/client'
import { contactEvents, customers, riskCases, type ActionRow } from '../db/schema'
import { evaluateStopGate, type StopContext } from '../policy/stop-gate'
import type { MessageSender, PaymentExecutor } from '../providers/port'
import type { Outbox } from './outbox'

export class DryRunViolationError extends Error {
  override readonly name = 'DryRunViolationError'
}

export interface DispatchPayload {
  readonly recipientRef: string
  readonly body: string
}

export interface ExecutorOptions {
  readonly db: Database
  readonly clock: Clock
  readonly ids: IdFactory
  readonly rng: Rng
  readonly logger: Logger
  readonly outbox: Outbox
  readonly authority: AuthorityConfig
  readonly payments: PaymentExecutor
  readonly senders: ReadonlyMap<Channel, MessageSender>
  readonly dryRun: boolean
  isHalted(): boolean
  stopContextFor(action: ActionRow, at: number): Promise<StopContext>
  payloadFor(action: ActionRow): Promise<DispatchPayload | undefined>
  readonly maxAttempts?: number
  readonly baseBackoffMs?: number
}

export interface DrainStats {
  readonly examined: number
  readonly sent: number
  readonly suppressed: number
  readonly deferred: number
  readonly retried: number
  readonly deadLettered: number
  readonly haltedByKillSwitch: boolean
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_BACKOFF_MS = 5 * 60_000

const MAX_DRAIN_ROUNDS = 100

const CHARGE_TYPES = new Set(['RETRY_CHARGE', 'RETRY_CHARGE_ALT_ROUTE', 'SPLIT_RETRY'])

export class Executor {
  private readonly options: ExecutorOptions
  private readonly locks = new KeyedMutex()
  private readonly backoffRng: Rng

  constructor(options: ExecutorOptions) {
    this.options = options
    this.backoffRng = options.rng.derive('backoff')
  }

  async drain(at: number, limit = 500): Promise<DrainStats> {
    const stats = {
      examined: 0,
      sent: 0,
      suppressed: 0,
      deferred: 0,
      retried: 0,
      deadLettered: 0,
      haltedByKillSwitch: false,
    }

    if (this.options.isHalted()) {
      this.options.logger.warn('executor_halted', { at })
      return { ...stats, haltedByKillSwitch: true }
    }

    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      const due = await this.options.outbox.due(at, limit)
      if (due.length === 0) return stats

      for (const action of due) {
        if (this.options.isHalted()) return { ...stats, haltedByKillSwitch: true }

        stats.examined++
        const outcome = await this.locks.run(action.caseId, () => this.execute(action, at))

        if (outcome === 'SENT') stats.sent++
        else if (outcome === 'SUPPRESSED') stats.suppressed++
        else if (outcome === 'DEFERRED') stats.deferred++
        else if (outcome === 'RETRIED') stats.retried++
        else if (outcome === 'DEAD_LETTERED') stats.deadLettered++
      }

      if (due.length < limit) return stats
    }

    this.options.logger.warn('outbox_drain_incomplete', { at, rounds: MAX_DRAIN_ROUNDS })
    return stats
  }

  private async execute(
    action: ActionRow,
    at: number,
  ): Promise<'SENT' | 'SUPPRESSED' | 'DEFERRED' | 'RETRIED' | 'DEAD_LETTERED' | 'SKIPPED'> {
    if (!(await this.options.outbox.claim(action.id))) return 'SKIPPED'

    const stopContext = await this.options.stopContextFor(action, at)
    const stop = evaluateStopGate(stopContext, this.options.authority)

    if (stop.verdict === 'STOP') {
      const reason: StopReason = stop.reason ?? 'STOP_EV_NEGATIVE'
      await this.options.outbox.markSuppressed(action.id, reason, at)
      await this.options.outbox.cancelPendingForCase(action.caseId, reason)
      await this.recordStop(action.caseId, reason, at)
      this.options.logger.info('action_suppressed_at_execute_time', {
        actionId: action.id,
        caseId: action.caseId,
        reason,
      })
      return 'SUPPRESSED'
    }

    if (stop.verdict === 'DEFER') {
      const until = stop.deferUntil ?? at + 60 * 60_000
      await this.options.outbox.reschedule(
        action.id,
        until,
        'deferred by the stop gate at execute time',
      )
      return 'DEFERRED'
    }

    try {
      return await this.dispatch(action, at)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'unknown dispatch error'
      if (cause instanceof DryRunViolationError) throw cause
      return this.handleFailure(action, at, message, true)
    }
  }

  private async dispatch(
    action: ActionRow,
    at: number,
  ): Promise<'SENT' | 'RETRIED' | 'DEAD_LETTERED' | 'SUPPRESSED'> {
    if (CHARGE_TYPES.has(action.type)) {
      const result = await this.options.payments.charge({
        idempotencyKey: action.idempotencyKey,
        caseId: action.caseId,
        amountPaise: paise(action.amountPaise ?? 0),
        method: undefined,
        at,
        dryRun: this.options.dryRun,
      })

      this.assertHonouredDryRun(result.attempted)

      if (!result.attempted) {
        await this.options.outbox.markSuppressed(action.id, 'dry run: no charge was attempted', at)
        return 'SUPPRESSED'
      }

      if (result.succeeded || !result.retryable) {
        await this.options.outbox.markSent(action.id, result.providerRef, result.costPaise, at)
        return 'SENT'
      }

      return this.handleFailure(action, at, result.failure?.reason ?? 'charge failed', true)
    }

    const channel = action.channel
    if (channel === null) {
      await this.options.outbox.markSent(action.id, undefined, paise(0), at)
      return 'SENT'
    }

    const sender = this.options.senders.get(channel)
    if (sender === undefined) {
      await this.options.outbox.deadLetter(action.id, `no sender registered for ${channel}`, at)
      return 'DEAD_LETTERED'
    }

    const payload = await this.options.payloadFor(action)
    if (payload === undefined) {
      await this.options.outbox.markSuppressed(action.id, 'content could not be rendered', at)
      return 'SUPPRESSED'
    }

    const result = await sender.send({
      idempotencyKey: action.idempotencyKey,
      caseId: action.caseId,
      actionType: action.type,
      channel,
      recipientRef: payload.recipientRef,
      templateId: action.templateId ?? 'UNKNOWN',
      language: action.language ?? 'en',
      body: payload.body,
      at,
      dryRun: this.options.dryRun,
    })

    this.assertHonouredDryRun(result.attempted)

    if (!result.attempted) {
      await this.options.outbox.markSuppressed(action.id, 'dry run: no message was sent', at)
      return 'SUPPRESSED'
    }

    if (result.accepted || !result.retryable) {
      await this.options.outbox.markSent(action.id, result.providerRef, result.costPaise, at)
      await this.recordContact(
        action,
        channel,
        payload,
        at,
        result.optedOut === true,
        result.replyBody,
      )
      return 'SENT'
    }

    return this.handleFailure(action, at, result.failureReason ?? 'send rejected', true)
  }

  private assertHonouredDryRun(attempted: boolean): void {
    if (this.options.dryRun && attempted) {
      throw new DryRunViolationError(
        'A provider reported a real attempt while DRY_RUN is engaged. Execution is halted: ' +
          'a dry run that touches the outside world is worse than no dry run at all.',
      )
    }
  }

  private async handleFailure(
    action: ActionRow,
    at: number,
    error: string,
    retryable: boolean,
  ): Promise<'RETRIED' | 'DEAD_LETTERED'> {
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const nextAttempt = action.attempts + 1

    if (!retryable || nextAttempt >= maxAttempts) {
      await this.options.outbox.deadLetter(action.id, error, at)
      this.options.logger.error('action_dead_lettered', {
        actionId: action.id,
        caseId: action.caseId,
        attempts: nextAttempt,
        error,
      })
      return 'DEAD_LETTERED'
    }

    await this.options.outbox.markRetry(action.id, at + this.backoff(nextAttempt), error)
    return 'RETRIED'
  }

  private backoff(attempt: number): number {
    const base = this.options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    const exponential = base * Math.pow(2, attempt - 1)
    return Math.round(exponential * (0.5 + this.backoffRng.next()))
  }

  private async recordContact(
    action: ActionRow,
    channel: Channel,
    payload: DispatchPayload,
    at: number,
    optedOut = false,
    replyBody: string | undefined = undefined,
  ): Promise<void> {
    const rows = await this.options.db
      .select({
        customerId: riskCases.customerId,
        touchCount: riskCases.touchCount,
        merchantId: riskCases.merchantId,
      })
      .from(riskCases)
      .where(eq(riskCases.id, action.caseId))
      .limit(1)

    const row = rows[0]
    if (row === undefined) return
    const merchantId = row.merchantId

    await this.options.db.insert(contactEvents).values({
      id: this.options.ids.next('contact'),
      merchantId,
      caseId: action.caseId,
      customerId: row.customerId,
      actionId: action.id,
      channel,
      direction: 'OUTBOUND',
      templateId: action.templateId,
      language: action.language ?? 'en',
      bodyHash: sha256(payload.body),
      body: payload.body,
      sentAt: at,
      delivered: true,
      replied: replyBody !== undefined,
      intent: null,
      optOut: optedOut,
    })

    if (replyBody !== undefined) {
      await this.options.db.insert(contactEvents).values({
        id: this.options.ids.next('contact'),
        merchantId,
        caseId: action.caseId,
        customerId: row.customerId,
        actionId: action.id,
        channel,
        direction: 'INBOUND',
        templateId: null,
        language: action.language ?? 'en',
        bodyHash: sha256(replyBody),
        body: replyBody,
        sentAt: at + 1,
        delivered: true,
        replied: false,
        intent: null,
        optOut: false,
      })
    }

    await this.options.db
      .update(riskCases)
      .set({ touchCount: row.touchCount + 1, updatedAt: at })
      .where(eq(riskCases.id, action.caseId))

    if (optedOut) {
      await this.options.db
        .update(customers)
        .set({ optedOutGlobal: true })
        .where(eq(customers.id, row.customerId))

      await this.options.outbox.cancelPendingForCase(action.caseId, 'STOP_OPT_OUT')
      this.options.logger.info('customer_opted_out', {
        caseId: action.caseId,
        customerId: row.customerId,
      })
    }
  }

  private async recordStop(caseId: string, reason: StopReason, at: number): Promise<void> {
    const terminal = reason === 'STOP_PAID' ? 'RECOVERED' : 'STOPPED'
    await this.options.db
      .update(riskCases)
      .set({ state: terminal, stopReason: reason, resolvedAt: at, updatedAt: at })
      .where(eq(riskCases.id, caseId))
  }
}
