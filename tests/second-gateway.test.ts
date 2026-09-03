import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { VirtualClock } from '../src/core/clock'
import { createIdFactory } from '../src/core/identifiers'
import { silentLogger } from '../src/core/logger'
import { paise } from '../src/core/money'
import type { DatabaseHandle } from '../src/db/client'
import { customers, decisions, riskCases } from '../src/db/schema'
import { StratifiedAssigner } from '../src/experiment/arm'
import { LedgerRepository } from '../src/ledger/ledger'
import { CardnetWebhookSource, signCardnetPayload } from '../src/providers/cardnet/adapter'
import { CaseProjector } from '../src/signal/case-projector'
import { WebhookReceiver } from '../src/signal/receiver'
import { createTestDatabase, seedMerchant } from './helpers/database'

const SECRET = 'cardnet_test_secret'
const MERCHANT = 'merch_test'
const AT = 1_760_000_000_000
const ISO = new Date(AT).toISOString()

function declineBody(overrides: {
  id: string
  reference: string
  amountMinor: number
  code?: string
  origin?: 'issuer' | 'network' | 'processor' | 'merchant'
  phase?: 'authorization' | 'authentication' | 'capture' | 'mandate'
  description?: string
}): string {
  return JSON.stringify({
    id: `evt_${overrides.id}`,
    type: 'charge.declined',
    occurred_at: ISO,
    livemode: false,
    data: {
      object: {
        id: overrides.id,
        reference: overrides.reference,
        customer_ref: 'ref_cardnet_1',
        amount_minor: overrides.amountMinor,
        amount_settled_minor: null,
        currency: 'INR',
        instrument: { kind: 'vpa', issuer: 'HDFC' },
        decline: {
          code: overrides.code ?? 'insufficient_funds',
          origin: overrides.origin ?? 'issuer',
          phase: overrides.phase ?? 'authorization',
          description: overrides.description ?? 'insufficient funds in the account',
        },
      },
    },
  })
}

describe('a second gateway reaches the same engine without touching it', () => {
  let handle: DatabaseHandle
  let receiver: WebhookReceiver
  let projector: CaseProjector
  let clock: VirtualClock

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
    await handle.db.insert(customers).values({
      id: 'cust_cardnet_1',
      merchantId: MERCHANT,
      externalRef: 'ref_cardnet_1',
      portfolio: 'd2c_subscription',
      languagePref: 'en',
      timezone: 'Asia/Kolkata',
      mandateCapPaise: paise(5_000_000),
      priorBillsSettled: 0,
      priorBillsPaid: 0,
      createdAt: AT - 86_400_000,
    })

    clock = new VirtualClock({ start: AT })
    const ids = createIdFactory('cardnet-test')

    receiver = new WebhookReceiver({
      db: handle.db,
      clock,
      ids,
      source: new CardnetWebhookSource(SECRET),
      logger: silentLogger,
    })

    projector = new CaseProjector({
      db: handle.db,
      clock,
      ids,
      logger: silentLogger,
      merchantId: MERCHANT,
      assigner: new StratifiedAssigner('cardnet-assignment'),
      policyVersion: 'test',
    })
  })

  afterEach(() => {
    handle.close()
  })

  it('opens a case from a wire format the engine has never seen', async () => {
    const rawBody = declineBody({ id: 'ch_1', reference: 'obl_1', amountMinor: 250_000 })
    const outcome = await receiver.receive({
      eventId: 'evt_cn_1',
      rawBody,
      signature: signCardnetPayload(rawBody, SECRET, 1_760_000_000),
    })

    expect(outcome.status).toBe('ACCEPTED')
    if (outcome.status !== 'ACCEPTED') return

    for (const signal of outcome.signals) await projector.project(signal)

    const rows = await handle.db.select().from(riskCases).where(eq(riskCases.merchantId, MERCHANT))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('FAILED_PAYMENT')
    expect(rows[0]?.amountPaise).toBe(250_000)
  })

  it('classifies its own decline codes into the shared failure taxonomy', async () => {
    const cases: [string, string, string][] = [
      ['insufficient_funds', 'insufficient funds in the account', 'FUNDS_TIMING'],
      ['card_expired', 'the card has expired', 'INSTRUMENT_INVALID'],
      ['do_not_honour', 'issuer suspects fraud on this card', 'RISK_DECLINE'],
    ]

    for (const [code, description, expected] of cases) {
      const source = new CardnetWebhookSource(SECRET)
      const rawBody = declineBody({
        id: `ch_${code}`,
        reference: `obl_${code}`,
        amountMinor: 250_000,
        code,
        description,
      })
      const parsed = source.parseWebhook(rawBody, `evt_${code}`)
      expect(parsed.signals[0]?.error?.failureClass).toBe(expected)
    }
  })

  it('rejects its own signature scheme when the body is altered', () => {
    const source = new CardnetWebhookSource(SECRET)
    const rawBody = declineBody({ id: 'ch_2', reference: 'obl_2', amountMinor: 250_000 })
    const signature = signCardnetPayload(rawBody, SECRET, 1_760_000_000)

    expect(source.verifyWebhook(rawBody, signature).valid).toBe(true)
    expect(source.verifyWebhook(`${rawBody} `, signature).valid).toBe(false)
    expect(source.verifyWebhook(rawBody, 'v1=deadbeef').valid).toBe(false)
    expect(source.verifyWebhook(rawBody, undefined).valid).toBe(false)
  })

  it('normalises amounts and instruments the way the first gateway does', () => {
    const source = new CardnetWebhookSource(SECRET)
    const rawBody = declineBody({ id: 'ch_3', reference: 'obl_3', amountMinor: 99_900 })
    const signal = source.parseWebhook(rawBody, 'evt_cn_3').signals[0]

    expect(signal?.amountPaise).toBe(99_900)
    expect(signal?.method).toBe('upi')
    expect(signal?.issuer).toBe('HDFC')
    expect(signal?.provider).toBe('cardnet')
  })

  it('decides on a cardnet case with no engine change at all', async () => {
    const rawBody = declineBody({ id: 'ch_4', reference: 'obl_4', amountMinor: 250_000 })
    const outcome = await receiver.receive({
      eventId: 'evt_cn_4',
      rawBody,
      signature: signCardnetPayload(rawBody, SECRET, 1_760_000_000),
    })
    if (outcome.status !== 'ACCEPTED') throw new Error('expected acceptance')
    for (const signal of outcome.signals) await projector.project(signal)

    const ledger = new LedgerRepository(handle.db, createIdFactory('cardnet-ledger'))
    const cases = await handle.db.select().from(riskCases)
    const caseId = cases[0]?.id
    expect(caseId).toBeDefined()
    if (caseId === undefined) return

    expect(await ledger.outstanding(caseId)).toBe(250_000)
    expect(await handle.db.select().from(decisions)).toHaveLength(0)
  })
})
