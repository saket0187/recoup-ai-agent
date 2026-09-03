import type { Paise } from '../core/money'
import type {
  ActionType,
  Channel,
  ErrorSource,
  ErrorStep,
  FailureClass,
  Language,
  PaymentMethod,
} from '../domain/enums'
import type { SourceEntity } from '../domain/records'

export interface NormalisedError {
  readonly code: string
  readonly source: ErrorSource
  readonly step: ErrorStep
  readonly reason: string
  readonly failureClass: FailureClass
  readonly confidence: number
  readonly ruleId: string
  readonly attributedTo: string
  readonly retryable: boolean
  readonly contactable: boolean
  readonly countsAgainstAttemptBudget: boolean
}

export const RISK_SIGNAL_KINDS = [
  'PAYMENT_FAILED',
  'PAYMENT_SUCCEEDED',
  'CHECKOUT_ABANDONED',
  'INVOICE_PAID',
  'INVOICE_PARTIALLY_PAID',
  'SUBSCRIPTION_CHARGED',
  'SUBSCRIPTION_HALTED',
  'SUBSCRIPTION_CANCELLED',
  'REFUND_PROCESSED',
  'DOWNTIME_STARTED',
  'DOWNTIME_RESOLVED',
] as const

export type RiskSignalKind = (typeof RISK_SIGNAL_KINDS)[number]

export interface DowntimeSignal {
  readonly downtimeId: string
  readonly method: PaymentMethod
  readonly issuer: string | undefined
  readonly severity: 'low' | 'medium' | 'high'
  readonly beganAt: number
  readonly endedAt: number | undefined
}

export interface RiskSignal {
  readonly kind: RiskSignalKind
  readonly provider: string
  readonly eventId: string
  readonly occurredAt: number
  readonly entity: SourceEntity
  readonly customerRef: string | undefined
  readonly obligationRef: string | undefined
  readonly amountPaise: Paise | undefined
  readonly amountPaidPaise: Paise | undefined
  readonly method: PaymentMethod | undefined
  readonly issuer: string | undefined
  readonly error: NormalisedError | undefined
  readonly downtime: DowntimeSignal | undefined
}

export interface WebhookVerification {
  readonly valid: boolean
  readonly reason: string | undefined
}

export interface ParsedWebhook {
  readonly provider: string
  readonly eventId: string
  readonly eventType: string
  readonly occurredAt: number
  readonly signals: readonly RiskSignal[]
}

export interface WebhookSource {
  readonly name: string
  verifyWebhook(rawBody: string, signature: string | undefined): WebhookVerification
  parseWebhook(rawBody: string, eventId: string): ParsedWebhook
}

export interface ChargeRequest {
  readonly idempotencyKey: string
  readonly caseId: string
  readonly amountPaise: Paise
  readonly method: PaymentMethod | undefined
  readonly at: number
  readonly dryRun: boolean
}

export interface ChargeResult {
  readonly attempted: boolean
  readonly succeeded: boolean
  readonly providerRef: string | undefined
  readonly failure: NormalisedError | undefined
  readonly costPaise: Paise
  readonly retryable: boolean
}

export interface PaymentExecutor {
  readonly name: string
  charge(request: ChargeRequest): Promise<ChargeResult>
}

export interface SendRequest {
  readonly idempotencyKey: string
  readonly caseId: string
  readonly actionType: ActionType
  readonly channel: Channel
  readonly recipientRef: string
  readonly templateId: string
  readonly language: Language
  readonly body: string
  readonly at: number
  readonly dryRun: boolean
}

export interface SendResult {
  readonly attempted: boolean
  readonly accepted: boolean
  readonly optedOut?: boolean
  readonly replyBody?: string
  readonly providerRef: string | undefined
  readonly costPaise: Paise
  readonly failureReason: string | undefined
  readonly retryable: boolean
}

export interface MessageSender {
  readonly name: string
  send(request: SendRequest): Promise<SendResult>
}
