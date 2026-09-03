import { and, eq, isNotNull } from 'drizzle-orm'

import { sha256 } from '../core/canonical-hash'
import type { Clock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import type { Logger } from '../core/logger'
import type { Database } from '../db/client'
import { providerEvents } from '../db/schema'
import { MalformedWebhookError } from '../providers/gateway/adapter'
import type { RiskSignal, WebhookSource } from '../providers/port'

const MAX_WEBHOOK_BODY_BYTES = 1_000_000

export function webhookEventId(rawBody: string, supplied: string | null): string {
  if (supplied !== null && supplied !== '') return supplied
  return `body_${sha256(rawBody).slice(0, 32)}`
}

export interface ReceiveRequest {
  readonly eventId: string
  readonly rawBody: string
  readonly signature: string | undefined
}

export type ReceiveOutcome =
  | { readonly status: 'ACCEPTED'; readonly signals: readonly RiskSignal[] }
  | { readonly status: 'DUPLICATE' }
  | { readonly status: 'REJECTED'; readonly reason: string }
  | { readonly status: 'DEAD_LETTERED'; readonly reason: string }

export interface ReceiverOptions {
  readonly db: Database
  readonly clock: Clock
  readonly ids: IdFactory
  readonly source: WebhookSource
  readonly logger: Logger
  readonly maxBodyBytes?: number
}

export class WebhookReceiver {
  private readonly db: Database
  private readonly clock: Clock
  private readonly ids: IdFactory
  private readonly source: WebhookSource
  private readonly logger: Logger
  private readonly maxBodyBytes: number

  constructor(options: ReceiverOptions) {
    this.db = options.db
    this.clock = options.clock
    this.ids = options.ids
    this.source = options.source
    this.logger = options.logger
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES
  }

  async receive(request: ReceiveRequest): Promise<ReceiveOutcome> {
    const byteLength = Buffer.byteLength(request.rawBody, 'utf8')
    if (byteLength > this.maxBodyBytes) {
      this.logger.warn('webhook_body_too_large', {
        eventId: request.eventId,
        byteLength,
        limit: this.maxBodyBytes,
      })
      return { status: 'REJECTED', reason: `body exceeds ${this.maxBodyBytes} bytes` }
    }

    const verification = this.source.verifyWebhook(request.rawBody, request.signature)
    if (!verification.valid) {
      this.logger.warn('webhook_signature_rejected', {
        eventId: request.eventId,
        reason: verification.reason,
      })
      return { status: 'REJECTED', reason: verification.reason ?? 'signature verification failed' }
    }

    const existing = await this.db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.provider, this.source.name),
          eq(providerEvents.eventId, request.eventId),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      this.logger.debug('webhook_duplicate', { eventId: request.eventId })
      return { status: 'DUPLICATE' }
    }

    const receivedAt = this.clock.now()
    const payloadHash = sha256(request.rawBody)

    try {
      const parsed = this.source.parseWebhook(request.rawBody, request.eventId)

      await this.persist({
        eventId: request.eventId,
        eventType: parsed.eventType,
        entityId:
          parsed.signals[0]?.entity.paymentId ?? parsed.signals[0]?.entity.invoiceId ?? null,
        payloadHash,
        rawBody: request.rawBody,
        providerCreatedAt: parsed.occurredAt,
        receivedAt,
        processedAt: receivedAt,
        processingError: null,
      })

      this.logger.info('webhook_accepted', {
        eventId: request.eventId,
        eventType: parsed.eventType,
        signals: parsed.signals.length,
      })

      return { status: 'ACCEPTED', signals: parsed.signals }
    } catch (cause) {
      if (!(cause instanceof MalformedWebhookError)) throw cause

      await this.persist({
        eventId: request.eventId,
        eventType: 'unparseable',
        entityId: null,
        payloadHash,
        rawBody: request.rawBody,
        providerCreatedAt: receivedAt,
        receivedAt,
        processedAt: null,
        processingError: cause.message,
      })

      this.logger.error('webhook_dead_lettered', {
        eventId: request.eventId,
        reason: cause.message,
      })

      return { status: 'DEAD_LETTERED', reason: cause.message }
    }
  }

  private async persist(row: {
    eventId: string
    eventType: string
    entityId: string | null
    payloadHash: string
    rawBody: string
    providerCreatedAt: number
    receivedAt: number
    processedAt: number | null
    processingError: string | null
  }): Promise<void> {
    await this.db.insert(providerEvents).values({
      id: this.ids.next('evt'),
      provider: this.source.name,
      eventId: row.eventId,
      eventType: row.eventType,
      entityId: row.entityId,
      payloadHash: row.payloadHash,
      rawBody: row.rawBody,
      providerCreatedAt: row.providerCreatedAt,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
      processingError: row.processingError,
    })
  }

  async deadLetters(): Promise<{ eventId: string; processingError: string | null }[]> {
    return this.db
      .select({
        eventId: providerEvents.eventId,
        processingError: providerEvents.processingError,
      })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.provider, this.source.name),
          isNotNull(providerEvents.processingError),
        ),
      )
  }
}
