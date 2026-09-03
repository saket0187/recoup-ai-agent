import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'

import { migrate } from 'drizzle-orm/libsql/migrator'

import { VirtualClock } from '../src/core/clock'
import { createIdFactory, createRuntimeIdFactory } from '../src/core/identifiers'
import { silentLogger } from '../src/core/logger'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import { createDatabase, type DatabaseHandle } from '../src/db/client'
import { actions, customers, decisions, merchants, riskCases } from '../src/db/schema'
import { observationSenders, ObservationPaymentExecutor } from '../src/providers/observation'
import { signPayload } from '../src/providers/gateway/adapter'
import { composeAgent, TickBusyError, type Agent } from '../src/runtime/compose'
import { GatewayEventEmitter } from '../src/sim/events'
import { SIGNATURES } from '../src/sim/error-signatures'

const SECRET = 'concurrency_secret'
const MERCHANT = 'merch_test'
const AT = 1_760_000_000_000
const DB_PATH = './data/concurrency-test.db'

const emitter = new GatewayEventEmitter(createIdFactory('concurrency-test'))

function failureEvent(paymentId: string): string {
  const signature = SIGNATURES['INSUFFICIENT_FUNDS'][0]
  if (signature === undefined) throw new Error('no signature fixture')
  return JSON.stringify(
    emitter.paymentFailed({
      paymentId,
      orderId: null,
      invoiceId: null,
      amountPaise: paise(250_000),
      method: 'upi',
      issuer: 'HDFC',
      vpa: null,
      signature,
      at: AT,
      notes: { obligation_id: `obl_${paymentId}`, customer_ref: 'ref_conc_1' },
    }),
  )
}

function agentFor(handle: DatabaseHandle, label: string): Agent {
  return composeAgent({
    db: handle.db,
    clock: new VirtualClock({ start: AT }),
    ids: createRuntimeIdFactory(label),
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
    leaseTicks: true,
  })
}

describe('two agents against one database', () => {
  let handle: DatabaseHandle

  beforeEach(async () => {
    rmSync(DB_PATH, { force: true })
    handle = await createDatabase(DB_PATH)
    await migrate(handle.db, { migrationsFolder: './drizzle' })

    await handle.db.insert(merchants).values({
      id: MERCHANT,
      name: 'Test Merchant',
      timezone: 'Asia/Kolkata',
      marginRateBp: 3000,
      paused: false,
      tickLeaseUntil: null,
      createdAt: AT,
    })
    await handle.db.insert(customers).values({
      id: 'cust_conc_1',
      merchantId: MERCHANT,
      externalRef: 'ref_conc_1',
      portfolio: 'd2c_subscription',
      languagePref: 'en',
      timezone: 'Asia/Kolkata',
      mandateCapPaise: paise(5_000_000),
      priorBillsSettled: 0,
      priorBillsPaid: 0,
      createdAt: AT - 86_400_000,
    })
  })

  afterEach(() => {
    handle.close()
    rmSync(DB_PATH, { force: true })
  })

  it('gives two boots disjoint id spaces, so a restart cannot collide', () => {
    const first = createRuntimeIdFactory('runtime')
    const second = createRuntimeIdFactory('runtime')
    expect(first.next('decision')).not.toBe(second.next('decision'))
  })

  it('lets only one of two overlapping ticks run', async () => {
    const a = agentFor(handle, 'a')
    const b = agentFor(handle, 'b')

    const body = failureEvent('pay_conc_1')
    await a.ingest({ eventId: 'evt_c1', rawBody: body, signature: signPayload(body, SECRET) })

    const results = await Promise.allSettled([a.tick(AT + 3_600_000), b.tick(AT + 3_600_000)])
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(TickBusyError)
  })

  it('never enqueues the same case and action twice within one decision window', async () => {
    const a = agentFor(handle, 'a')
    const b = agentFor(handle, 'b')

    const body = failureEvent('pay_conc_2')
    await a.ingest({ eventId: 'evt_c2', rawBody: body, signature: signPayload(body, SECRET) })

    await a.tick(AT + 3_600_000)
    await b.tick(AT + 3_600_000).catch(() => undefined)

    const enqueued = await handle.db.select().from(actions)
    const keys = enqueued.map((row) => row.idempotencyKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps the decision row and the case advance atomic', async () => {
    const a = agentFor(handle, 'a')
    const body = failureEvent('pay_conc_3')
    await a.ingest({ eventId: 'evt_c3', rawBody: body, signature: signPayload(body, SECRET) })
    await a.tick(AT + 3_600_000)

    const decided = await handle.db.select().from(decisions)
    const cases = await handle.db.select().from(riskCases)

    expect(decided.length).toBeGreaterThan(0)
    for (const row of cases) {
      if (decided.some((d) => d.caseId === row.id)) {
        expect(row.nextDecisionAt).not.toBeNull()
      }
    }
  })

  it('halts every send while the kill switch is engaged', async () => {
    let halted = false
    const agent = composeAgent({
      db: handle.db,
      clock: new VirtualClock({ start: AT }),
      ids: createRuntimeIdFactory('halt'),
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
      killSwitchEngaged: () => halted,
    })

    const body = failureEvent('pay_conc_4')
    await agent.ingest({ eventId: 'evt_c4', rawBody: body, signature: signPayload(body, SECRET) })

    halted = true
    const stats = await agent.tick(AT + 3_600_000)
    expect(stats.drain.haltedByKillSwitch).toBe(true)
  })

  it('halts when the merchant row is paused', async () => {
    const agent = agentFor(handle, 'paused')
    const body = failureEvent('pay_conc_5')
    await agent.ingest({ eventId: 'evt_c5', rawBody: body, signature: signPayload(body, SECRET) })

    await handle.db.update(merchants).set({ paused: true })
    const stats = await agent.tick(AT + 3_600_000)
    expect(stats.drain.haltedByKillSwitch).toBe(true)
  })
})
