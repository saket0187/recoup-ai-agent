import { createHmac, timingSafeEqual } from 'node:crypto'

import { paise } from '../../core/money'
import type { PaymentMethod } from '../../domain/enums'
import { gatewayEventSchema, type GatewayEvent, type PaymentEntity } from './webhook-schema'
import type {
  ParsedWebhook,
  RiskSignal,
  RiskSignalKind,
  WebhookSource,
  WebhookVerification,
} from '../port'
import { classifyError } from './failure-mapping'

export class MalformedWebhookError extends Error {
  override readonly name = 'MalformedWebhookError'
}

const SIGNAL_KIND_BY_EVENT: Readonly<Record<GatewayEvent['event'], RiskSignalKind>> = {
  'payment.failed': 'PAYMENT_FAILED',
  'payment.captured': 'PAYMENT_SUCCEEDED',
  'payment.authorized': 'PAYMENT_SUCCEEDED',
  'subscription.charged': 'SUBSCRIPTION_CHARGED',
  'subscription.halted': 'SUBSCRIPTION_HALTED',
  'subscription.cancelled': 'SUBSCRIPTION_CANCELLED',
  'order.abandoned': 'CHECKOUT_ABANDONED',
  'invoice.paid': 'INVOICE_PAID',
  'invoice.partially_paid': 'INVOICE_PARTIALLY_PAID',
  'payment.downtime.started': 'DOWNTIME_STARTED',
  'payment.downtime.resolved': 'DOWNTIME_RESOLVED',
  'refund.processed': 'REFUND_PROCESSED',
}

function toMillis(seconds: number): number {
  return seconds * 1000
}

function paymentMethod(entity: PaymentEntity): PaymentMethod {
  return entity.method
}

export class GatewayWebhookSource implements WebhookSource {
  readonly name = 'gateway'
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

    const expected = createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex')
    const expectedBytes = Buffer.from(expected, 'utf8')
    const providedBytes = Buffer.from(signature, 'utf8')

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

    const parsed = gatewayEventSchema.safeParse(json)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new MalformedWebhookError(`body does not match the gateway event schema: ${detail}`)
    }

    const event = parsed.data
    const occurredAt = toMillis(event.created_at)

    return {
      provider: this.name,
      eventId,
      eventType: event.event,
      occurredAt,
      signals: this.toSignals(event, eventId, occurredAt),
    }
  }

  private toSignals(event: GatewayEvent, eventId: string, occurredAt: number): RiskSignal[] {
    const kind = SIGNAL_KIND_BY_EVENT[event.event]
    const base = {
      kind,
      provider: this.name,
      eventId,
      occurredAt,
    } as const

    const payment = event.payload.payment?.entity
    if (payment !== undefined) {
      const notes = payment.notes
      return [
        {
          ...base,
          entity: {
            ...(payment.id === null ? {} : { paymentId: payment.id }),
            ...(payment.order_id === null ? {} : { orderId: payment.order_id }),
            ...(payment.invoice_id === null ? {} : { invoiceId: payment.invoice_id }),
          },
          customerRef: notes.customer_ref,
          obligationRef: notes.obligation_id,
          amountPaise: paise(payment.amount),
          amountPaidPaise: undefined,
          method: paymentMethod(payment),
          issuer: payment.bank ?? undefined,
          error:
            kind === 'PAYMENT_FAILED'
              ? classifyError({
                  code: payment.error_code,
                  source: payment.error_source,
                  step: payment.error_step,
                  reason: payment.error_reason,
                })
              : undefined,
          downtime: undefined,
        },
      ]
    }

    const invoice = event.payload.invoice?.entity
    if (invoice !== undefined) {
      return [
        {
          ...base,
          entity: { invoiceId: invoice.id },
          customerRef: invoice.notes.customer_ref ?? invoice.customer_id,
          obligationRef: invoice.notes.obligation_id,
          amountPaise: paise(invoice.amount),
          amountPaidPaise: paise(invoice.amount_paid),
          method: undefined,
          issuer: undefined,
          error: undefined,
          downtime: undefined,
        },
      ]
    }

    const subscription = event.payload.subscription?.entity
    if (subscription !== undefined) {
      return [
        {
          ...base,
          entity: { subscriptionId: subscription.id },
          customerRef: subscription.notes.customer_ref ?? subscription.customer_id,
          obligationRef: subscription.notes.obligation_id,
          amountPaise: undefined,
          amountPaidPaise: undefined,
          method: undefined,
          issuer: undefined,
          error: undefined,
          downtime: undefined,
        },
      ]
    }

    const order = event.payload.order?.entity
    if (order !== undefined) {
      return [
        {
          ...base,
          entity: { orderId: order.id },
          customerRef: order.notes.customer_ref ?? order.customer_id ?? undefined,
          obligationRef: order.notes.obligation_id,
          amountPaise: paise(order.amount - order.amount_paid),
          amountPaidPaise: paise(order.amount_paid),
          method: order.method ?? undefined,
          issuer: undefined,
          error: undefined,
          downtime: undefined,
        },
      ]
    }

    const downtime = event.payload['payment.downtime']?.entity
    if (downtime !== undefined) {
      return [
        {
          ...base,
          entity: {},
          customerRef: undefined,
          obligationRef: undefined,
          amountPaise: undefined,
          amountPaidPaise: undefined,
          method: downtime.method,
          issuer: downtime.instrument.issuer ?? undefined,
          error: undefined,
          downtime: {
            downtimeId: downtime.id,
            method: downtime.method,
            issuer: downtime.instrument.issuer ?? undefined,
            severity: downtime.severity,
            beganAt: toMillis(downtime.begin),
            endedAt: downtime.end === null ? undefined : toMillis(downtime.end),
          },
        },
      ]
    }

    throw new MalformedWebhookError(`event ${event.event} carried no recognisable entity`)
  }
}

export function signPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}
