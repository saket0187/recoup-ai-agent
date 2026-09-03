import type { ErrorSource, ErrorStep, FailureClass } from '../../domain/enums'
import type { NormalisedError } from '../port'

interface MappingRule {
  readonly id: string
  readonly reasons?: readonly string[]
  readonly reasonPattern?: RegExp
  readonly sources?: readonly ErrorSource[]
  readonly steps?: readonly ErrorStep[]
  readonly failureClass: FailureClass
  readonly confidence: number
  readonly attributedTo: string
}

const CLASS_POLICY: Readonly<
  Record<
    FailureClass,
    { retryable: boolean; contactable: boolean; countsAgainstAttemptBudget: boolean }
  >
> = {
  TRANSIENT_INFRA: { retryable: true, contactable: false, countsAgainstAttemptBudget: false },
  FUNDS_TIMING: { retryable: true, contactable: true, countsAgainstAttemptBudget: true },
  AUTH_DROPOFF: { retryable: false, contactable: true, countsAgainstAttemptBudget: true },
  INSTRUMENT_INVALID: { retryable: false, contactable: true, countsAgainstAttemptBudget: true },
  MANDATE_BROKEN: { retryable: false, contactable: true, countsAgainstAttemptBudget: true },
  RISK_DECLINE: { retryable: false, contactable: false, countsAgainstAttemptBudget: true },
  MERCHANT_DEFECT: { retryable: false, contactable: false, countsAgainstAttemptBudget: false },
  AMBIGUOUS: { retryable: false, contactable: false, countsAgainstAttemptBudget: true },
}

const RULES: readonly MappingRule[] = [
  {
    id: 'MAP_MANDATE_CAP',
    reasonPattern: /mandate.*(max|amount|cap|exceed)/i,
    failureClass: 'MANDATE_BROKEN',
    confidence: 0.97,
    attributedTo: 'merchant_mandate_configuration',
  },
  {
    id: 'MAP_MANDATE_DEAD',
    reasonPattern: /mandate.*(revok|cancel|expir|paus|invalid)|(revok|expir).*mandate/i,
    failureClass: 'MANDATE_BROKEN',
    confidence: 0.97,
    attributedTo: 'customer_mandate',
  },
  {
    id: 'MAP_MERCHANT_INPUT',
    reasons: ['input_validation_failed', 'invalid_request', 'amount_mismatch'],
    failureClass: 'MERCHANT_DEFECT',
    confidence: 0.98,
    attributedTo: 'merchant_integration',
  },
  {
    id: 'MAP_DOWNTIME',
    reasonPattern: /downtime|bank_unavailable|issuer_unavailable/i,
    failureClass: 'TRANSIENT_INFRA',
    confidence: 0.95,
    attributedTo: 'bank_or_gateway',
  },
  {
    id: 'MAP_TECHNICAL',
    reasons: [
      'gateway_technical_error',
      'server_error',
      'network_error',
      'payment_timeout_gateway',
    ],
    failureClass: 'TRANSIENT_INFRA',
    confidence: 0.92,
    attributedTo: 'bank_or_gateway',
  },
  {
    id: 'MAP_INSUFFICIENT_FUNDS',
    reasonPattern: /insufficient|low_balance/i,
    failureClass: 'FUNDS_TIMING',
    confidence: 0.97,
    attributedTo: 'customer_balance',
  },
  {
    id: 'MAP_LIMIT',
    reasonPattern: /limit_exceeded|exceeds_limit|per_transaction_limit/i,
    failureClass: 'FUNDS_TIMING',
    confidence: 0.93,
    attributedTo: 'issuer_limit',
  },
  {
    id: 'MAP_AUTH_DROPOFF',
    reasonPattern: /otp|3ds|authentication_failed|payment_cancelled|payment_timeout|user_abandon/i,
    steps: ['payment_authentication', 'payment_initiation'],
    failureClass: 'AUTH_DROPOFF',
    confidence: 0.94,
    attributedTo: 'customer_authentication',
  },
  {
    id: 'MAP_CARD_DEAD',
    reasonPattern: /card_expired|expired_card|card_blocked|card_stolen|lost_card|restricted_card/i,
    failureClass: 'INSTRUMENT_INVALID',
    confidence: 0.97,
    attributedTo: 'customer_instrument',
  },
  {
    id: 'MAP_VPA_DEAD',
    reasonPattern: /invalid_vpa|vpa_not_found|account_closed|invalid_account|account_frozen/i,
    failureClass: 'INSTRUMENT_INVALID',
    confidence: 0.96,
    attributedTo: 'customer_instrument',
  },
  {
    id: 'MAP_RISK',
    reasonPattern: /do_not_honour|do_not_honor|risk|fraud|suspected|declined_by_bank/i,
    failureClass: 'RISK_DECLINE',
    confidence: 0.9,
    attributedTo: 'issuer_risk',
  },
  {
    id: 'MAP_BUSINESS_SOURCE',
    sources: ['business'],
    failureClass: 'MERCHANT_DEFECT',
    confidence: 0.85,
    attributedTo: 'merchant_integration',
  },
  {
    id: 'MAP_INFRA_SOURCE',
    sources: ['gateway', 'internal', 'network'],
    failureClass: 'TRANSIENT_INFRA',
    confidence: 0.75,
    attributedTo: 'bank_or_gateway',
  },
  {
    id: 'MAP_BANK_AUTHORIZATION',
    sources: ['bank'],
    steps: ['payment_authorization'],
    failureClass: 'TRANSIENT_INFRA',
    confidence: 0.7,
    attributedTo: 'bank_or_gateway',
  },
  {
    id: 'MAP_CUSTOMER_AUTHENTICATION',
    sources: ['customer'],
    steps: ['payment_authentication'],
    failureClass: 'AUTH_DROPOFF',
    confidence: 0.72,
    attributedTo: 'customer_authentication',
  },
]

function matches(
  rule: MappingRule,
  source: ErrorSource,
  step: ErrorStep,
  reason: string,
  code: string,
): boolean {
  if (
    rule.reasons !== undefined &&
    !rule.reasons.includes(reason) &&
    !rule.reasons.includes(code)
  ) {
    return false
  }
  if (
    rule.reasonPattern !== undefined &&
    !rule.reasonPattern.test(reason) &&
    !rule.reasonPattern.test(code)
  ) {
    return false
  }
  if (rule.sources !== undefined && !rule.sources.includes(source)) return false
  if (rule.steps !== undefined && !rule.steps.includes(step)) return false
  return (
    rule.reasons !== undefined || rule.reasonPattern !== undefined || rule.sources !== undefined
  )
}

export interface RawGatewayError {
  readonly code: string | null
  readonly source: ErrorSource | null
  readonly step: ErrorStep | null
  readonly reason: string | null
}

export function classifyError(raw: RawGatewayError): NormalisedError {
  const source = raw.source ?? 'nbfc'
  const step = raw.step ?? 'payment_authorization'
  const reason = raw.reason ?? 'unspecified'

  const code = raw.code ?? 'UNKNOWN'
  const rule = RULES.find((candidate) => matches(candidate, source, step, reason, code))

  const failureClass = rule?.failureClass ?? 'AMBIGUOUS'
  const policy = CLASS_POLICY[failureClass]

  return {
    code,
    source,
    step,
    reason,
    failureClass,
    confidence: rule?.confidence ?? 0.3,
    ruleId: rule?.id ?? 'MAP_UNMAPPED',
    attributedTo: rule?.attributedTo ?? 'unknown',
    ...policy,
  }
}

export function errorSignature(raw: RawGatewayError): string {
  return `${raw.source ?? 'null'}|${raw.step ?? 'null'}|${raw.reason ?? 'null'}`
}

export function isUnmapped(error: NormalisedError): boolean {
  return error.ruleId === 'MAP_UNMAPPED'
}
