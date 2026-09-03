import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { VirtualClock } from '../src/core/clock'
import { createIdFactory } from '../src/core/identifiers'
import { silentLogger } from '../src/core/logger'
import { paise } from '../src/core/money'
import type { DatabaseHandle } from '../src/db/client'
import { diagnoses, riskCases } from '../src/db/schema'
import { StratifiedAssigner } from '../src/experiment/arm'
import { LedgerRepository } from '../src/ledger/ledger'
import { GatewayWebhookSource, signPayload } from '../src/providers/gateway/adapter'
import type { GatewayEvent } from '../src/providers/gateway/webhook-schema'
import { CaseProjector } from '../src/signal/case-projector'
import { WebhookReceiver } from '../src/signal/receiver'
import { GatewayEventEmitter } from '../src/sim/events'
import { SIGNATURES } from '../src/sim/error-signatures'
import { createTestDatabase, seedMerchant } from './helpers/database'

const SECRET = 'test_webhook_secret'
const MERCHANT = 'merch_test'
const AT = 1_760_000_000_000

const source = new GatewayWebhookSource(SECRET)
const emitter = new GatewayEventEmitter(createIdFactory('signal-test'))

function body(event: GatewayEvent): string {
  return JSON.stringify(event)
}

function failureEvent(overrides: {
  paymentId: string
  invoiceId?: string
  amountPaise: number
  cause?: keyof typeof SIGNATURES
  at?: number
}): GatewayEvent {
  const signature = SIGNATURES[overrides.cause ?? 'INSUFFICIENT_FUNDS'][0]
  if (signature === undefined) throw new Error('no signature fixture')
  return emitter.paymentFailed({
    paymentId: overrides.paymentId,
    orderId: null,
    invoiceId: overrides.invoiceId ?? null,
    amountPaise: paise(overrides.amountPaise),
    method: 'upi',
    issuer: 'HDFC',
    vpa: null,
    signature,
    at: overrides.at ?? AT,
    notes: { obligation_id: 'obl_1', customer_ref: 'acct-000001' },
  })
}

function captureEvent(overrides: {
  paymentId: string
  invoiceId?: string
  amountPaise: number
  at?: number
}): GatewayEvent {
  return emitter.paymentCaptured({
    paymentId: overrides.paymentId,
    orderId: null,
    invoiceId: overrides.invoiceId ?? null,
    amountPaise: paise(overrides.amountPaise),
    method: 'upi',
    issuer: 'HDFC',
    at: overrides.at ?? AT,
    notes: { obligation_id: 'obl_1', customer_ref: 'acct-000001' },
  })
}

describe('webhook verification', () => {
  it('accepts a signature computed over the raw body', () => {
    const raw = body(failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 }))
    expect(source.verifyWebhook(raw, signPayload(raw, SECRET)).valid).toBe(true)
  })

  it('rejects a body altered after signing, even by one character', () => {
    const raw = body(failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 }))
    const signature = signPayload(raw, SECRET)
    const tampered = raw.replace('100000', '900000')
    expect(source.verifyWebhook(tampered, signature).valid).toBe(false)
  })

  it('rejects a re-serialised body, which is the classic integration bug', () => {
    const event = failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 })
    const raw = body(event)
    const signature = signPayload(raw, SECRET)
    const reserialised = JSON.stringify(JSON.parse(raw), Object.keys(event).sort())
    expect(source.verifyWebhook(reserialised, signature).valid).toBe(false)
  })

  it('rejects a missing signature and a wrong secret', () => {
    const raw = body(failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 }))
    expect(source.verifyWebhook(raw, undefined).valid).toBe(false)
    expect(source.verifyWebhook(raw, signPayload(raw, 'wrong')).valid).toBe(false)
  })

  it('refuses to verify anything when no secret is configured', () => {
    const raw = body(failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 }))
    const unconfigured = new GatewayWebhookSource(undefined)
    expect(unconfigured.verifyWebhook(raw, signPayload(raw, SECRET)).valid).toBe(false)
  })
})

describe('WebhookReceiver', () => {
  let handle: DatabaseHandle
  let receiver: WebhookReceiver

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
    receiver = new WebhookReceiver({
      db: handle.db,
      clock: new VirtualClock({ start: AT }),
      ids: createIdFactory('receiver'),
      source,
      logger: silentLogger,
    })
  })

  afterEach(() => {
    handle.close()
  })

  const deliver = (
    event: GatewayEvent,
    eventId: string,
  ): ReturnType<WebhookReceiver['receive']> => {
    const raw = body(event)
    return receiver.receive({ eventId, rawBody: raw, signature: signPayload(raw, SECRET) })
  }

  it('accepts a well-formed event and returns its signals', async () => {
    const outcome = await deliver(
      failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 }),
      'evt_1',
    )
    expect(outcome.status).toBe('ACCEPTED')
    if (outcome.status !== 'ACCEPTED') return
    expect(outcome.signals).toHaveLength(1)
    expect(outcome.signals[0]?.kind).toBe('PAYMENT_FAILED')
    expect(outcome.signals[0]?.error?.failureClass).toBe('FUNDS_TIMING')
  })

  it('is idempotent on redelivery of the same event id', async () => {
    const event = failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 })
    expect((await deliver(event, 'evt_1')).status).toBe('ACCEPTED')
    expect((await deliver(event, 'evt_1')).status).toBe('DUPLICATE')
    expect((await deliver(event, 'evt_1')).status).toBe('DUPLICATE')
  })

  it('rejects an unsigned delivery without persisting it', async () => {
    const raw = body(failureEvent({ paymentId: 'pay_1', amountPaise: 100_000 }))
    const outcome = await receiver.receive({ eventId: 'evt_x', rawBody: raw, signature: 'nope' })
    expect(outcome.status).toBe('REJECTED')
    expect(await receiver.deadLetters()).toHaveLength(0)
  })

  it('dead-letters a malformed body instead of crashing', async () => {
    const raw = '{"entity":"event","not":"a real event"}'
    const outcome = await receiver.receive({
      eventId: 'evt_bad',
      rawBody: raw,
      signature: signPayload(raw, SECRET),
    })
    expect(outcome.status).toBe('DEAD_LETTERED')
    expect(await receiver.deadLetters()).toHaveLength(1)
  })

  it('dead-letters unparseable JSON', async () => {
    const raw = 'not json at all'
    const outcome = await receiver.receive({
      eventId: 'evt_bad2',
      rawBody: raw,
      signature: signPayload(raw, SECRET),
    })
    expect(outcome.status).toBe('DEAD_LETTERED')
  })

  it('rejects an oversized body before parsing it', async () => {
    const raw = 'x'.repeat(2_000_000)
    const outcome = await receiver.receive({
      eventId: 'evt_big',
      rawBody: raw,
      signature: signPayload(raw, SECRET),
    })
    expect(outcome.status).toBe('REJECTED')
    if (outcome.status === 'REJECTED') expect(outcome.reason).toMatch(/exceeds/)
  })
})

describe('CaseProjector', () => {
  let handle: DatabaseHandle
  let projector: CaseProjector
  let ledger: LedgerRepository
  let clock: VirtualClock

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
    clock = new VirtualClock({ start: AT })
    const ids = createIdFactory('projector')
    ledger = new LedgerRepository(handle.db, ids)
    projector = new CaseProjector({
      db: handle.db,
      clock,
      ids,
      logger: silentLogger,
      merchantId: MERCHANT,
      assigner: new StratifiedAssigner('test-salt'),
      policyVersion: 'test-1',
    })
  })

  afterEach(() => {
    handle.close()
  })

  const project = async (event: GatewayEvent, eventId: string): Promise<void> => {
    const parsed = source.parseWebhook(body(event), eventId)
    for (const signal of parsed.signals) await projector.project(signal)
  }

  it('opens a case with a charge on the ledger and an assigned arm', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')

    const rows = await handle.db.select().from(riskCases)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.amountPaise).toBe(250_000)
    expect(['TREATMENT', 'CONTROL']).toContain(rows[0]?.arm)
    expect(rows[0]?.stratum).toBe('low|FUNDS_TIMING')
    expect(await ledger.outstanding(rows[0]?.id ?? '')).toBe(250_000)
  })

  it('records a diagnosis with the mapping rule as evidence', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')

    const rows = await handle.db.select().from(diagnoses)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.failureClass).toBe('FUNDS_TIMING')
    expect(rows[0]?.method).toBe('TABLE')
    expect(rows[0]?.evidence).toContainEqual({ field: 'rule_id', value: 'MAP_INSUFFICIENT_FUNDS' })
  })

  it('does not charge the attempt budget for a merchant defect', async () => {
    await project(
      failureEvent({ paymentId: 'pay_1', amountPaise: 250_000, cause: 'MERCHANT_DEFECT' }),
      'evt_1',
    )
    const rows = await handle.db.select().from(riskCases)
    expect(rows[0]?.attemptCount).toBe(0)
  })

  it('does charge the attempt budget for a funds failure', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')
    const rows = await handle.db.select().from(riskCases)
    expect(rows[0]?.attemptCount).toBe(1)
  })

  it('marks a case recovered once the ledger clears', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')
    await project(captureEvent({ paymentId: 'pay_2', amountPaise: 250_000 }), 'evt_2')

    const rows = await handle.db.select().from(riskCases)
    expect(rows[0]?.state).toBe('RECOVERED')
    expect(rows[0]?.recoveredPaise).toBe(250_000)
    expect(rows[0]?.resolvedAt).not.toBeNull()
  })

  it('reaches the same state whichever order the events arrive in', async () => {
    await project(
      captureEvent({ paymentId: 'pay_2', amountPaise: 250_000, at: AT + 60_000 }),
      'evt_2',
    )
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000, at: AT }), 'evt_1')

    const rows = await handle.db.select().from(riskCases)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('RECOVERED')
    expect(await ledger.outstanding(rows[0]?.id ?? '')).toBe(0)
  })

  it('does not double-count a payment replayed under the same provider reference', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')
    await project(captureEvent({ paymentId: 'pay_2', amountPaise: 250_000 }), 'evt_2')
    await project(captureEvent({ paymentId: 'pay_2', amountPaise: 250_000 }), 'evt_3')

    const rows = await handle.db.select().from(riskCases)
    expect(await ledger.outstanding(rows[0]?.id ?? '')).toBe(0)
    expect(await ledger.history(rows[0]?.id ?? '')).toHaveLength(2)
  })

  it('leaves a partially paid case open for the remainder', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')
    await project(captureEvent({ paymentId: 'pay_2', amountPaise: 100_000 }), 'evt_2')

    const rows = await handle.db.select().from(riskCases)
    expect(rows[0]?.state).not.toBe('RECOVERED')
    expect(await ledger.outstanding(rows[0]?.id ?? '')).toBe(150_000)
  })

  it('recognises a B2B short payment as tax deducted at source, not a shortfall', async () => {
    await project(
      failureEvent({ paymentId: 'pay_1', invoiceId: 'inv_1', amountPaise: 10_000_000 }),
      'evt_1',
    )
    await project(
      captureEvent({ paymentId: 'pay_2', invoiceId: 'inv_1', amountPaise: 9_000_000 }),
      'evt_2',
    )

    const rows = await handle.db
      .select()
      .from(riskCases)
      .where(eq(riskCases.type, 'INVOICE_OVERDUE'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('RECOVERED')

    const history = await ledger.history(rows[0]?.id ?? '')
    expect(history.some((event) => event.type === 'TDS_ADJUSTMENT')).toBe(true)
    expect(await ledger.outstanding(rows[0]?.id ?? '')).toBe(0)
  })

  it('does not invent a TDS adjustment for an arbitrary shortfall', async () => {
    await project(
      failureEvent({ paymentId: 'pay_1', invoiceId: 'inv_2', amountPaise: 10_000_000 }),
      'evt_1',
    )
    await project(
      captureEvent({ paymentId: 'pay_2', invoiceId: 'inv_2', amountPaise: 6_300_000 }),
      'evt_2',
    )

    const rows = await handle.db.select().from(riskCases)
    const history = await ledger.history(rows[0]?.id ?? '')
    expect(history.some((event) => event.type === 'TDS_ADJUSTMENT')).toBe(false)
    expect(rows[0]?.state).not.toBe('RECOVERED')
  })

  it('opens exactly one case for repeated failures on the same obligation', async () => {
    await project(failureEvent({ paymentId: 'pay_1', amountPaise: 250_000 }), 'evt_1')
    await project(
      failureEvent({ paymentId: 'pay_2', amountPaise: 250_000, at: AT + 1000 }),
      'evt_2',
    )
    await project(
      failureEvent({ paymentId: 'pay_3', amountPaise: 250_000, at: AT + 2000 }),
      'evt_3',
    )

    const rows = await handle.db.select().from(riskCases)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attemptCount).toBe(3)
    expect(await ledger.outstanding(rows[0]?.id ?? '')).toBe(250_000)
  })

  it('ignores downtime signals, which belong to no single case', async () => {
    const event = emitter.downtime('payment.downtime.started', {
      downtimeId: 'down_1',
      method: 'upi',
      issuer: 'HDFC',
      begin: AT,
      end: null,
      severity: 'high',
      at: AT,
    })
    await project(event, 'evt_down')
    expect(await handle.db.select().from(riskCases)).toHaveLength(0)
  })
})
