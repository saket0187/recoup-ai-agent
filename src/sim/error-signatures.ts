import type { ErrorSource, ErrorStep } from '../domain/enums'

export const SIM_FAILURE_CAUSES = [
  'DOWNTIME',
  'GATEWAY_ERROR',
  'INSUFFICIENT_FUNDS',
  'LIMIT_EXCEEDED',
  'OTP_FAILED',
  'USER_CANCELLED',
  'CARD_EXPIRED',
  'CARD_BLOCKED',
  'VPA_INVALID',
  'MANDATE_REVOKED',
  'MANDATE_CAP_EXCEEDED',
  'RISK_DECLINE',
  'MERCHANT_DEFECT',
  'UNKNOWN',
] as const

export type SimFailureCause = (typeof SIM_FAILURE_CAUSES)[number]

export interface ErrorSignature {
  readonly code: string
  readonly description: string
  readonly source: ErrorSource
  readonly step: ErrorStep
  readonly reason: string
}

export const SIGNATURES: Readonly<Record<SimFailureCause, readonly ErrorSignature[]>> = {
  DOWNTIME: [
    {
      code: 'GATEWAY_ERROR',
      description: 'Payment processing failed because of an error at the bank',
      source: 'bank',
      step: 'payment_authorization',
      reason: 'payment_failed_due_to_bank_downtime',
    },
    {
      code: 'GATEWAY_ERROR',
      description: 'Payment could not be completed due to a technical error',
      source: 'gateway',
      step: 'payment_authorization',
      reason: 'gateway_technical_error',
    },
  ],
  GATEWAY_ERROR: [
    {
      code: 'GATEWAY_ERROR',
      description: 'Payment failed due to a temporary technical error',
      source: 'gateway',
      step: 'payment_initiation',
      reason: 'gateway_technical_error',
    },
    {
      code: 'SERVER_ERROR',
      description: 'An internal error occurred while processing the payment',
      source: 'internal',
      step: 'payment_authorization',
      reason: 'server_error',
    },
  ],
  INSUFFICIENT_FUNDS: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Your payment could not be completed due to insufficient balance',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'payment_failed_insufficient_funds',
    },
  ],
  LIMIT_EXCEEDED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment exceeds the limit set on the account',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'payment_limit_exceeded',
    },
  ],
  OTP_FAILED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment failed because the OTP entered was incorrect',
      source: 'customer',
      step: 'payment_authentication',
      reason: 'invalid_otp',
    },
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment was not completed in time',
      source: 'customer',
      step: 'payment_authentication',
      reason: 'payment_timeout',
    },
  ],
  USER_CANCELLED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment was cancelled by the customer',
      source: 'customer',
      step: 'payment_authentication',
      reason: 'payment_cancelled',
    },
  ],
  CARD_EXPIRED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment failed because the card has expired',
      source: 'customer',
      step: 'payment_authorization',
      reason: 'payment_failed_card_expired',
    },
  ],
  CARD_BLOCKED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'The card used is blocked for online transactions',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'card_blocked',
    },
  ],
  VPA_INVALID: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'The UPI ID entered is not valid',
      source: 'customer',
      step: 'payment_initiation',
      reason: 'invalid_vpa',
    },
  ],
  MANDATE_REVOKED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'The mandate for this subscription has been revoked',
      source: 'customer',
      step: 'payment_authorization',
      reason: 'mandate_revoked',
    },
  ],
  MANDATE_CAP_EXCEEDED: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Debit amount exceeds the maximum amount authorised on the mandate',
      source: 'business',
      step: 'payment_initiation',
      reason: 'mandate_max_amount_exceeded',
    },
  ],
  RISK_DECLINE: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'The issuing bank declined the payment',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'payment_do_not_honour',
    },
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment declined by risk checks',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'payment_declined_by_risk',
    },
  ],
  MERCHANT_DEFECT: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'The amount field is invalid',
      source: 'business',
      step: 'payment_initiation',
      reason: 'input_validation_failed',
    },
  ],
  UNKNOWN: [
    {
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment failed for an unspecified reason',
      source: 'nbfc',
      step: 'payment_authorization',
      reason: 'payment_failed_unspecified',
    },
  ],
}

export function signaturesFor(cause: SimFailureCause): readonly ErrorSignature[] {
  const signatures = SIGNATURES[cause]
  if (signatures.length === 0) {
    throw new RangeError(`No error signatures registered for cause ${cause}`)
  }
  return signatures
}
