import type { IdFactory } from '../core/identifiers'
import type { Paise } from '../core/money'
import type { PaymentMethod } from '../domain/enums'
import {
  gatewayEventSchema,
  type GatewayEvent,
  type GatewayEventType,
} from '../providers/gateway/webhook-schema'
import type { ErrorSignature } from './error-signatures'

const EMPTY_NOTES: Record<string, string> = {}

function toSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000)
}

export interface PaymentFailedInput {
  readonly paymentId: string
  readonly orderId: string | null
  readonly invoiceId: string | null
  readonly amountPaise: Paise
  readonly method: PaymentMethod
  readonly issuer: string | null
  readonly vpa: string | null
  readonly signature: ErrorSignature
  readonly at: number
  readonly notes?: Record<string, string>
}

export interface PaymentCapturedInput {
  readonly paymentId: string
  readonly orderId: string | null
  readonly invoiceId: string | null
  readonly amountPaise: Paise
  readonly method: PaymentMethod
  readonly issuer: string | null
  readonly at: number
  readonly notes?: Record<string, string>
}

export interface SubscriptionInput {
  readonly subscriptionId: string
  readonly customerId: string
  readonly planId: string
  readonly status: string
  readonly paidCount: number
  readonly totalCount: number
  readonly chargeAt: number | null
  readonly at: number
  readonly notes?: Record<string, string>
}

export interface InvoiceInput {
  readonly invoiceId: string
  readonly customerId: string
  readonly amountPaise: Paise
  readonly amountPaidPaise: Paise
  readonly dueBy: number | null
  readonly at: number
  readonly notes?: Record<string, string>
}

export interface DowntimeInput {
  readonly downtimeId: string
  readonly method: PaymentMethod
  readonly issuer: string | null
  readonly begin: number
  readonly end: number | null
  readonly severity: 'low' | 'medium' | 'high'
  readonly at: number
}

export interface OrderAbandonedInput {
  readonly orderId: string
  readonly amountPaise: number
  readonly attempts: number
  readonly method: PaymentMethod | undefined
  readonly customerId: string
  readonly createdAt: number
  readonly at: number
  readonly notes: { obligation_id?: string; customer_ref?: string }
}

export class GatewayEventEmitter {
  private readonly ids: IdFactory
  private readonly accountId: string

  constructor(ids: IdFactory, accountId = 'acc_simulation') {
    this.ids = ids
    this.accountId = accountId
  }

  private envelope(
    event: GatewayEventType,
    contains: readonly string[],
    payload: GatewayEvent['payload'],
    at: number,
  ): GatewayEvent {
    return gatewayEventSchema.parse({
      entity: 'event',
      account_id: this.accountId,
      event,
      contains: [...contains],
      payload,
      created_at: toSeconds(at),
    })
  }

  paymentFailed(input: PaymentFailedInput): GatewayEvent {
    return this.envelope(
      'payment.failed',
      ['payment'],
      {
        payment: {
          entity: {
            id: input.paymentId,
            entity: 'payment',
            amount: input.amountPaise,
            currency: 'INR',
            status: 'failed',
            order_id: input.orderId,
            invoice_id: input.invoiceId,
            international: false,
            method: input.method,
            amount_refunded: 0,
            captured: false,
            description: null,
            bank: input.issuer,
            wallet: null,
            vpa: input.vpa,
            notes: input.notes ?? EMPTY_NOTES,
            fee: null,
            tax: null,
            error_code: input.signature.code,
            error_description: input.signature.description,
            error_source: input.signature.source,
            error_step: input.signature.step,
            error_reason: input.signature.reason,
            created_at: toSeconds(input.at),
          },
        },
      },
      input.at,
    )
  }

  paymentCaptured(input: PaymentCapturedInput): GatewayEvent {
    return this.envelope(
      'payment.captured',
      ['payment'],
      {
        payment: {
          entity: {
            id: input.paymentId,
            entity: 'payment',
            amount: input.amountPaise,
            currency: 'INR',
            status: 'captured',
            order_id: input.orderId,
            invoice_id: input.invoiceId,
            international: false,
            method: input.method,
            amount_refunded: 0,
            captured: true,
            description: null,
            bank: input.issuer,
            wallet: null,
            vpa: null,
            notes: input.notes ?? EMPTY_NOTES,
            fee: Math.round(input.amountPaise * 0.02),
            tax: Math.round(input.amountPaise * 0.0036),
            error_code: null,
            error_description: null,
            error_source: null,
            error_step: null,
            error_reason: null,
            created_at: toSeconds(input.at),
          },
        },
      },
      input.at,
    )
  }

  subscription(
    event: 'subscription.charged' | 'subscription.halted' | 'subscription.cancelled',
    input: SubscriptionInput,
  ): GatewayEvent {
    return this.envelope(
      event,
      ['subscription'],
      {
        subscription: {
          entity: {
            id: input.subscriptionId,
            entity: 'subscription',
            plan_id: input.planId,
            customer_id: input.customerId,
            status: input.status,
            current_start: toSeconds(input.at),
            current_end: null,
            charge_at: input.chargeAt === null ? null : toSeconds(input.chargeAt),
            paid_count: input.paidCount,
            total_count: input.totalCount,
            remaining_count: Math.max(0, input.totalCount - input.paidCount),
            notes: input.notes ?? EMPTY_NOTES,
            created_at: toSeconds(input.at),
          },
        },
      },
      input.at,
    )
  }

  orderAbandoned(input: OrderAbandonedInput): GatewayEvent {
    return this.envelope(
      'order.abandoned',
      ['order'],
      {
        order: {
          entity: {
            entity: 'order',
            id: input.orderId,
            amount: input.amountPaise,
            amount_paid: 0,
            currency: 'INR',
            status: input.attempts > 0 ? 'attempted' : 'created',
            attempts: input.attempts,
            method: input.method ?? null,
            customer_id: input.customerId,
            created_at: toSeconds(input.createdAt),
            notes: input.notes,
          },
        },
      },
      input.at,
    )
  }

  invoice(event: 'invoice.paid' | 'invoice.partially_paid', input: InvoiceInput): GatewayEvent {
    return this.envelope(
      event,
      ['invoice'],
      {
        invoice: {
          entity: {
            id: input.invoiceId,
            entity: 'invoice',
            customer_id: input.customerId,
            order_id: null,
            status: event === 'invoice.paid' ? 'paid' : 'partially_paid',
            amount: input.amountPaise,
            amount_paid: input.amountPaidPaise,
            amount_due: input.amountPaise - input.amountPaidPaise,
            currency: 'INR',
            due_by: input.dueBy === null ? null : toSeconds(input.dueBy),
            notes: input.notes ?? EMPTY_NOTES,
            created_at: toSeconds(input.at),
          },
        },
      },
      input.at,
    )
  }

  downtime(
    event: 'payment.downtime.started' | 'payment.downtime.resolved',
    input: DowntimeInput,
  ): GatewayEvent {
    return this.envelope(
      event,
      ['payment.downtime'],
      {
        'payment.downtime': {
          entity: {
            id: input.downtimeId,
            entity: 'payment.downtime',
            method: input.method,
            begin: toSeconds(input.begin),
            end: input.end === null ? null : toSeconds(input.end),
            status: event === 'payment.downtime.started' ? 'started' : 'resolved',
            scheduled: false,
            severity: input.severity,
            instrument: { issuer: input.issuer, psp: null },
            created_at: toSeconds(input.at),
          },
        },
      },
      input.at,
    )
  }

  nextPaymentId(): string {
    return this.ids.next('pay')
  }

  nextDowntimeId(): string {
    return this.ids.next('down')
  }
}
