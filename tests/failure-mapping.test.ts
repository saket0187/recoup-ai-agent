import { describe, expect, it } from 'vitest'

import { classifyError, errorSignature, isUnmapped } from '../src/providers/gateway/failure-mapping'

describe('classifyError: one case per recovery class', () => {
  it('TRANSIENT_INFRA: a gateway technical error is nobody’s fault but ours to wait out', () => {
    const error = classifyError({
      code: 'GATEWAY_ERROR',
      source: 'gateway',
      step: 'payment_authorization',
      reason: 'gateway_technical_error',
    })
    expect(error.failureClass).toBe('TRANSIENT_INFRA')
    expect(error.retryable).toBe(true)
    expect(error.contactable).toBe(false)
    expect(error.countsAgainstAttemptBudget).toBe(false)
  })

  it('FUNDS_TIMING: insufficient funds is retryable and worth a heads-up', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'payment_failed_insufficient_funds',
    })
    expect(error.failureClass).toBe('FUNDS_TIMING')
    expect(error.retryable).toBe(true)
    expect(error.contactable).toBe(true)
  })

  it('AUTH_DROPOFF: a wrong OTP means contact fast, do not retry the same route', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'customer',
      step: 'payment_authentication',
      reason: 'invalid_otp',
    })
    expect(error.failureClass).toBe('AUTH_DROPOFF')
    expect(error.retryable).toBe(false)
    expect(error.contactable).toBe(true)
  })

  it('INSTRUMENT_INVALID: an expired card can never be retried into working', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'customer',
      step: 'payment_authorization',
      reason: 'payment_failed_card_expired',
    })
    expect(error.failureClass).toBe('INSTRUMENT_INVALID')
    expect(error.retryable).toBe(false)
    expect(error.contactable).toBe(true)
  })

  it('MANDATE_BROKEN: a revoked mandate is dead for charging', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'customer',
      step: 'payment_authorization',
      reason: 'mandate_revoked',
    })
    expect(error.failureClass).toBe('MANDATE_BROKEN')
    expect(error.retryable).toBe(false)
  })

  it('RISK_DECLINE: do-not-honour must not trigger aggressive dunning', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'issuer',
      step: 'payment_authorization',
      reason: 'payment_do_not_honour',
    })
    expect(error.failureClass).toBe('RISK_DECLINE')
    expect(error.contactable).toBe(false)
  })

  it('MERCHANT_DEFECT: our own malformed request must never reach the customer', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'business',
      step: 'payment_initiation',
      reason: 'input_validation_failed',
    })
    expect(error.failureClass).toBe('MERCHANT_DEFECT')
    expect(error.contactable).toBe(false)
    expect(error.countsAgainstAttemptBudget).toBe(false)
    expect(error.attributedTo).toBe('merchant_integration')
  })

  it('AMBIGUOUS: an unrecognised reason is admitted, not guessed at', () => {
    const error = classifyError({
      code: 'WEIRD',
      source: 'nbfc',
      step: 'payment_capture',
      reason: 'something_nobody_has_seen_before',
    })
    expect(error.failureClass).toBe('AMBIGUOUS')
    expect(isUnmapped(error)).toBe(true)
    expect(error.confidence).toBeLessThan(0.5)
    expect(error.contactable).toBe(false)
  })
})

describe('precedence', () => {
  it('reads a mandate cap breach as a mandate problem, not a generic business defect', () => {
    const error = classifyError({
      code: 'BAD_REQUEST_ERROR',
      source: 'business',
      step: 'payment_initiation',
      reason: 'mandate_max_amount_exceeded',
    })
    expect(error.failureClass).toBe('MANDATE_BROKEN')
    expect(error.attributedTo).toBe('merchant_mandate_configuration')
  })

  it('falls back to the source when the reason is unfamiliar', () => {
    const error = classifyError({
      code: 'X',
      source: 'business',
      step: 'payment_initiation',
      reason: 'some_new_business_error',
    })
    expect(error.failureClass).toBe('MERCHANT_DEFECT')
    expect(error.confidence).toBeLessThan(0.9)
  })

  it('treats a bank authorisation failure as infrastructure, not customer fault', () => {
    const error = classifyError({
      code: 'X',
      source: 'bank',
      step: 'payment_authorization',
      reason: 'unrecognised_bank_reason',
    })
    expect(error.failureClass).toBe('TRANSIENT_INFRA')
  })

  it('never blames the customer for a downtime reason', () => {
    const error = classifyError({
      code: 'GATEWAY_ERROR',
      source: 'bank',
      step: 'payment_authorization',
      reason: 'payment_failed_due_to_bank_downtime',
    })
    expect(error.failureClass).toBe('TRANSIENT_INFRA')
    expect(error.contactable).toBe(false)
  })
})

describe('missing fields', () => {
  it('classifies a wholly absent error object as ambiguous rather than throwing', () => {
    const error = classifyError({ code: null, source: null, step: null, reason: null })
    expect(error.failureClass).toBe('AMBIGUOUS')
    expect(error.code).toBe('UNKNOWN')
    expect(error.reason).toBe('unspecified')
  })

  it('always reports a stable rule id for the audit record', () => {
    expect(
      classifyError({
        code: 'X',
        source: 'issuer',
        step: 'payment_authorization',
        reason: 'insufficient_funds',
      }).ruleId,
    ).toBe('MAP_INSUFFICIENT_FUNDS')
  })
})

describe('errorSignature', () => {
  it('keys the model cache by the triple, not the free-text description', () => {
    expect(
      errorSignature({ code: 'A', source: 'issuer', step: 'payment_authorization', reason: 'x' }),
    ).toBe('issuer|payment_authorization|x')
  })

  it('is stable for nulls', () => {
    expect(errorSignature({ code: null, source: null, step: null, reason: null })).toBe(
      'null|null|null',
    )
  })
})
