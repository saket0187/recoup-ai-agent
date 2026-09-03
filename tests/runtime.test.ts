import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { VirtualClock } from '../src/core/clock'
import { createIdFactory } from '../src/core/identifiers'
import { silentLogger } from '../src/core/logger'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import { ThompsonBandit } from '../src/decision/bandit'
import { BanditStore } from '../src/decision/bandit-store'
import type { DatabaseHandle } from '../src/db/client'
import { customers, decisions, riskCases } from '../src/db/schema'
import { observationSenders, ObservationPaymentExecutor } from '../src/providers/observation'
import { signPayload } from '../src/providers/gateway/adapter'
import type { GatewayEvent } from '../src/providers/gateway/webhook-schema'
import { composeAgent, type Agent } from '../src/runtime/compose'
import { webhookEventId } from '../src/signal/receiver'
import { GatewayEventEmitter } from '../src/sim/events'
import { SIGNATURES } from '../src/sim/error-signatures'
import { createTestDatabase, seedMerchant } from './helpers/database'

const SECRET = 'runtime_test_secret'
const MERCHANT = 'merch_test'
const CUSTOMER = 'cust_runtime_1'
const AT = 1_760_000_000_000

const emitter = new GatewayEventEmitter(createIdFactory('runtime-test'))

function failureEvent(paymentId: string, amountPaise: number, at: number): GatewayEvent {
  const signature = SIGNATURES['INSUFFICIENT_FUNDS'][0]
  if (signature === undefined) throw new Error('no signature fixture')
  return emitter.paymentFailed({
    paymentId,
    orderId: null,
    invoiceId: null,
    amountPaise: paise(amountPaise),
    method: 'upi',
    issuer: 'HDFC',
    vpa: null,
    signature,
    at,
    notes: { obligation_id: `obl_${paymentId}`, customer_ref: 'ref_runtime_1' },
  })
}

async function deliver(agent: Agent, event: GatewayEvent, eventId: string): Promise<string> {
  const rawBody = JSON.stringify(event)
  const outcome = await agent.ingest({
    eventId,
    rawBody,
    signature: signPayload(rawBody, SECRET),
  })
  return outcome.status
}

describe('composeAgent: the runtime the webhook and the harness share', () => {
  let handle: DatabaseHandle
  let agent: Agent
  let clock: VirtualClock

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
    await handle.db.insert(customers).values({
      id: CUSTOMER,
      merchantId: MERCHANT,
      externalRef: 'ref_runtime_1',
      portfolio: 'd2c_subscription',
      languagePref: 'en',
      timezone: 'Asia/Kolkata',
      mandateCapPaise: paise(5_000_000),
      priorBillsSettled: 4,
      priorBillsPaid: 2,
      createdAt: AT - 86_400_000,
    })

    clock = new VirtualClock({ start: AT })
    agent = composeAgent({
      db: handle.db,
      clock,
      ids: createIdFactory('runtime-compose'),
      rng: createRng(42),
      logger: silentLogger,
      seed: 42,
      merchantId: MERCHANT,
      merchantName: 'Test Merchant',
      webhookSecret: SECRET,
      payments: new ObservationPaymentExecutor(),
      senders: observationSenders(),
      dryRun: true,
      bankHolidays: new Set<string>(),
      isFestival: () => false,
    })
  })

  afterEach(() => {
    handle.close()
  })

  it('projects a case from a signed webhook body', async () => {
    expect(await deliver(agent, failureEvent('pay_rt_1', 250_000, AT), 'evt_1')).toBe('ACCEPTED')

    const rows = await handle.db.select().from(riskCases).where(eq(riskCases.merchantId, MERCHANT))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('FAILED_PAYMENT')
    expect(rows[0]?.amountPaise).toBe(250_000)
  })

  it('rejects a body whose signature does not match', async () => {
    const event = failureEvent('pay_rt_2', 250_000, AT)
    const outcome = await agent.ingest({
      eventId: 'evt_bad',
      rawBody: JSON.stringify(event),
      signature: 'not-the-signature',
    })

    expect(outcome.status).toBe('REJECTED')
    const rows = await handle.db.select().from(riskCases)
    expect(rows).toHaveLength(0)
  })

  it('treats a replayed event as a duplicate and projects nothing twice', async () => {
    const event = failureEvent('pay_rt_3', 250_000, AT)
    expect(await deliver(agent, event, 'evt_3')).toBe('ACCEPTED')
    expect(await deliver(agent, event, 'evt_3')).toBe('DUPLICATE')

    const rows = await handle.db.select().from(riskCases)
    expect(rows).toHaveLength(1)
  })

  it('decides on the projected case when the loop is ticked', async () => {
    await deliver(agent, failureEvent('pay_rt_4', 250_000, AT), 'evt_4')

    const stats = await agent.tick(AT + 3_600_000)

    expect(stats.cycle.decided).toBeGreaterThan(0)
    const recorded = await handle.db.select().from(decisions)
    expect(recorded.length).toBeGreaterThan(0)
    expect(recorded.every((row) => row.propensity > 0)).toBe(true)
  })

  it('never reports a real attempt while dry run is engaged', async () => {
    await deliver(agent, failureEvent('pay_rt_5', 250_000, AT), 'evt_5')
    const stats = await agent.tick(AT + 3_600_000)
    expect(stats.drain.deadLettered).toBe(0)
  })

  it('takes its own clock when tick is called without a time', async () => {
    await deliver(agent, failureEvent('pay_rt_6', 250_000, AT), 'evt_6')
    await expect(agent.tick()).resolves.toBeDefined()
  })
})
describe('bandit posteriors survive a restart', () => {
  let handle: DatabaseHandle

  const ARM = {
    action: 'RETRY_CHARGE' as const,
    method: 'upi' as const,
    issuer: 'HDFC',
    dayBucket: 'mid_month',
    hourSlot: 3,
    failureClass: 'FUNDS_TIMING' as const,
    attemptBucket: 'first',
  }

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
  })

  afterEach(() => {
    handle.close()
  })

  it('reloads what an earlier process learned', async () => {
    const first = new ThompsonBandit(createRng(1).derive('bandit'))
    const store = new BanditStore(handle.db, MERCHANT)

    for (let i = 0; i < 12; i++) first.update(ARM, true)
    for (let i = 0; i < 3; i++) first.update(ARM, false)
    const learned = first.mean(ARM)

    expect(await store.flush(first, AT)).toBe(1)

    const second = new ThompsonBandit(createRng(2).derive('bandit'))
    expect(second.mean(ARM)).not.toBeCloseTo(learned, 6)

    await new BanditStore(handle.db, MERCHANT).load(second)
    expect(second.mean(ARM)).toBeCloseTo(learned, 12)
  })

  it('accumulates rather than clobbering when two processes flush', async () => {
    const a = new ThompsonBandit(createRng(1).derive('bandit'))
    const b = new ThompsonBandit(createRng(2).derive('bandit'))

    for (let i = 0; i < 5; i++) a.update(ARM, true)
    for (let i = 0; i < 7; i++) b.update(ARM, true)

    await new BanditStore(handle.db, MERCHANT).flush(a, AT)
    await new BanditStore(handle.db, MERCHANT).flush(b, AT + 1)

    const merged = new ThompsonBandit(createRng(3).derive('bandit'))
    await new BanditStore(handle.db, MERCHANT).load(merged)

    const alone = new ThompsonBandit(createRng(4).derive('bandit'))
    for (let i = 0; i < 12; i++) alone.update(ARM, true)

    expect(merged.mean(ARM)).toBeCloseTo(alone.mean(ARM), 12)
  })

  it('drains its pending deltas so a second flush writes nothing', async () => {
    const bandit = new ThompsonBandit(createRng(1).derive('bandit'))
    const store = new BanditStore(handle.db, MERCHANT)

    bandit.update(ARM, true)
    expect(await store.flush(bandit, AT)).toBe(1)
    expect(await store.flush(bandit, AT + 1)).toBe(0)
  })
})

describe('webhook event identity', () => {
  it('derives the same id for an identical redelivered body', () => {
    const body = '{"event":"payment.failed","id":"pay_1"}'
    expect(webhookEventId(body, null)).toBe(webhookEventId(body, null))
  })

  it('derives a different id for a different body', () => {
    expect(webhookEventId('{"a":1}', null)).not.toBe(webhookEventId('{"a":2}', null))
  })

  it('prefers an id the sender supplied over the body hash', () => {
    expect(webhookEventId('{"a":1}', 'evt_from_gateway')).toBe('evt_from_gateway')
    expect(webhookEventId('{"a":1}', '')).toBe(webhookEventId('{"a":1}', null))
  })
})
