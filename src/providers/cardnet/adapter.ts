import { createHmac, timingSafeEqual } from 'node:crypto'

import { paise } from '../../core/money'
import type { ErrorSource, ErrorStep, PaymentMethod } from '../../domain/enums'
import { classifyError } from '../gateway/failure-mapping'
import type {
  ParsedWebhook,
  RiskSignal,
  RiskSignalKind,
  WebhookSource,
  WebhookVerification,
} from '../port'
import { MalformedWebhookError } from '../gateway/adapter'
import { cardnetEventSchema, type CardnetEvent } from './webhook-schema'

const SIGNAL_KIND_BY_TYPE: Readonly<Record<CardnetEvent['type'], RiskSignalKind>> = {
  'charge.declined': 'PAYMENT_FAILED',
  'charge.succeeded': 'PAYMENT_SUCCEEDED',
  'checkout.session.expired': 'CHECKOUT_ABANDONED',
  'invoice.settled': 'INVOICE_PAID',
  'invoice.part_settled': 'INVOICE_PARTIALLY_PAID',
  'mandate.revoked': 'SUBSCRIPTION_CANCELLED',
}

const METHOD_BY_INSTRUMENT: Readonly<Record<string, PaymentMethod>> = {
  card: 'card',
  bank_debit: 'netbanking',
  vpa: 'upi',
  wallet: 'wallet',
}

const SOURCE_BY_ORIGIN: Readonly<Record<string, ErrorSource>> = {
  issuer: 'issuer',
  network: 'network',
  processor: 'gateway',
  merchant: 'business',
}

const STEP_BY_PHASE: Readonly<Record<string, ErrorStep>> = {
  authorization: 'payment_authorization',
  authentication: 'payment_authentication',
  capture: 'payment_capture',
  mandate: 'payment_initiation',
}

export class CardnetWebhookSource implements WebhookSource {
  readonly name = 'cardnet'
  private readonly secret: string | undefined

  constructor(secret: string | undefined) {
    this.secret = secret
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookVerification {
    if (this.secret === undefined || this.secret === '') {
      return { valid: false, reason: 'no webhook secret is configured' }
    }
    if (signature === undefined || signature === '') {
      return { valid: false, reason: 'signature header is missing' }
    }

    const parts = new Map(
      signature
        .split(',')
        .map((part) => part.split('=', 2))
        .filter((pair): pair is [string, string] => pair.length === 2)
        .map(([key, value]) => [key.trim(), value.trim()]),
    )

    const timestamp = parts.get('t')
    const provided = parts.get('v1')
    if (timestamp === undefined || provided === undefined) {
      return { valid: false, reason: 'signature is not in t=,v1= form' }
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')

    const expectedBytes = Buffer.from(expected, 'utf8')
    const providedBytes = Buffer.from(provided, 'utf8')

    if (expectedBytes.length !== providedBytes.length) {
      return { valid: false, reason: 'signature length mismatch' }
    }
    if (!timingSafeEqual(expectedBytes, providedBytes)) {
      return { valid: false, reason: 'signature does not match the raw body' }
    }

    return { valid: true, reason: undefined }
  }

  parseWebhook(rawBody: string, eventId: string): ParsedWebhook {
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch (cause) {
      throw new MalformedWebhookError(
        `body is not valid JSON: ${cause instanceof Error ? cause.message : 'unknown'}`,
      )
    }

    const parsed = cardnetEventSchema.safeParse(json)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new MalformedWebhookError(`body does not match the cardnet event schema: ${detail}`)
    }

    const event = parsed.data
    const occurredAt = Date.parse(event.occurred_at)
    if (Number.isNaN(occurredAt)) {
      throw new MalformedWebhookError(`occurred_at is not an ISO timestamp: ${event.occurred_at}`)
    }

    return {
      provider: this.name,
      eventId,
      eventType: event.type,
      occurredAt,
      signals: [this.toSignal(event, eventId, occurredAt)],
    }
  }

  private toSignal(event: CardnetEvent, eventId: string, occurredAt: number): RiskSignal {
    const object = event.data.object
    const decline = object.decline

    return {
      kind: SIGNAL_KIND_BY_TYPE[event.type],
      provider: this.name,
      eventId,
      occurredAt,
      entity: event.type.startsWith('invoice')
        ? { invoiceId: object.id }
        : event.type === 'checkout.session.expired'
          ? { orderId: object.id }
          : { paymentId: object.id },
      customerRef: object.customer_ref ?? undefined,
      obligationRef: object.reference ?? undefined,
      amountPaise: paise(object.amount_minor),
      amountPaidPaise:
        object.amount_settled_minor === null ? undefined : paise(object.amount_settled_minor),
      method: object.instrument === null ? undefined : METHOD_BY_INSTRUMENT[object.instrument.kind],
      issuer: object.instrument?.issuer ?? undefined,
      error:
        decline === null
          ? undefined
          : classifyError({
              code: decline.code,
              source: SOURCE_BY_ORIGIN[decline.origin] ?? null,
              step: STEP_BY_PHASE[decline.phase] ?? null,
              reason: decline.description,
            }),
      downtime: undefined,
    }
  }
}

export function signCardnetPayload(rawBody: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
  return `t=${timestamp},v1=${digest}`
}
