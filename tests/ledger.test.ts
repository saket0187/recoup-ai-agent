import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createIdFactory } from '../src/core/identifiers'
import { paise } from '../src/core/money'
import type { DatabaseHandle } from '../src/db/client'
import { customers, riskCases } from '../src/db/schema'
import {
  LedgerConflictError,
  LedgerRepository,
  isPartiallySettled,
  isSettled,
} from '../src/ledger/ledger'
import { createTestDatabase, seedMerchant } from './helpers/database'

const MERCHANT = 'merch_test'
const CUSTOMER = 'cust_1'
const CASE = 'case_1'

describe('LedgerRepository', () => {
  let handle: DatabaseHandle
  let ledger: LedgerRepository

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
    await handle.db.insert(customers).values({
      id: CUSTOMER,
      merchantId: MERCHANT,
      externalRef: 'ext_1',
      portfolio: 'b2b_invoice',
      createdAt: 0,
    })
    await handle.db.insert(riskCases).values({
      id: CASE,
      merchantId: MERCHANT,
      customerId: CUSTOMER,
      type: 'INVOICE_OVERDUE',
      amountPaise: 1_000_000,
      currency: 'INR',
      dueAt: 0,
      sourceEntity: { invoiceId: 'inv_1' },
      state: 'OPEN',
      arm: 'TREATMENT',
      stratum: 'high|FUNDS_TIMING',
      policyVersion: 'v1',
      firstSeenAt: 0,
      updatedAt: 0,
    })
    ledger = new LedgerRepository(handle.db, createIdFactory('test'))
  })

  afterEach(() => {
    handle.close()
  })

  const charge = (amount: number, at = 0): Promise<unknown> =>
    ledger.append({
      caseId: CASE,
      merchantId: MERCHANT,
      type: 'CHARGE',
      amountPaise: paise(amount),
      at,
    })

  const pay = (amount: number, at: number, providerRef?: string): Promise<unknown> =>
    ledger.append({
      caseId: CASE,
      merchantId: MERCHANT,
      type: 'PAYMENT',
      amountPaise: paise(amount),
      at,
      ...(providerRef === undefined ? {} : { providerRef }),
    })

  it('applies the sign from the event type so a caller cannot get it wrong', async () => {
    await charge(1_000_000)
    await pay(400_000, 10)

    const history = await ledger.history(CASE)
    expect(history[0]?.amountPaise).toBe(1_000_000)
    expect(history[1]?.amountPaise).toBe(-400_000)
  })

  it('rejects a negative or zero magnitude', async () => {
    await expect(charge(0)).rejects.toThrow(/positive magnitude/)
    await expect(charge(-100)).rejects.toThrow(/positive magnitude/)
  })

  it('derives outstanding rather than storing it', async () => {
    await charge(1_000_000)
    expect(await ledger.outstanding(CASE)).toBe(1_000_000)

    await pay(300_000, 10)
    expect(await ledger.outstanding(CASE)).toBe(700_000)

    await pay(700_000, 20)
    expect(await ledger.outstanding(CASE)).toBe(0)
  })

  it('reports zero for a case with no events', async () => {
    expect(await ledger.outstanding('case_unknown')).toBe(0)
  })

  it('reduces the balance for credit notes, TDS and write-offs', async () => {
    await charge(1_000_000)
    await ledger.append({
      caseId: CASE,
      merchantId: MERCHANT,
      type: 'CREDIT_NOTE',
      amountPaise: paise(100_000),
      at: 5,
    })
    await ledger.append({
      caseId: CASE,
      merchantId: MERCHANT,
      type: 'TDS_ADJUSTMENT',
      amountPaise: paise(20_000),
      at: 6,
    })
    expect(await ledger.outstanding(CASE)).toBe(880_000)
  })

  it('increases the balance again on a refund', async () => {
    await charge(1_000_000)
    await pay(1_000_000, 10)
    expect(await ledger.outstanding(CASE)).toBe(0)

    await ledger.append({
      caseId: CASE,
      merchantId: MERCHANT,
      type: 'REFUND',
      amountPaise: paise(1_000_000),
      at: 20,
    })
    expect(await ledger.outstanding(CASE)).toBe(1_000_000)
  })

  it('computes the balance as of an instant, ignoring later events', async () => {
    await charge(1_000_000)
    await pay(400_000, 100)
    await pay(600_000, 200)

    expect(await ledger.outstandingAsOf(CASE, 50)).toBe(1_000_000)
    expect(await ledger.outstandingAsOf(CASE, 100)).toBe(600_000)
    expect(await ledger.outstandingAsOf(CASE, 150)).toBe(600_000)
    expect(await ledger.outstandingAsOf(CASE, 200)).toBe(0)
  })

  it('reports total paid as a positive figure', async () => {
    await charge(1_000_000)
    await pay(400_000, 100)
    await pay(250_000, 200)
    expect(await ledger.totalPaidAsOf(CASE, 300)).toBe(650_000)
    expect(await ledger.totalPaidAsOf(CASE, 150)).toBe(400_000)
  })

  it('is idempotent on a repeated provider reference', async () => {
    await charge(1_000_000)
    await pay(400_000, 100, 'pay_abc123')
    await pay(400_000, 100, 'pay_abc123')
    await pay(400_000, 999, 'pay_abc123')

    expect(await ledger.outstanding(CASE)).toBe(600_000)
    expect(await ledger.history(CASE)).toHaveLength(2)
  })

  it('refuses a provider reference replayed with a different amount', async () => {
    await charge(1_000_000)
    await pay(400_000, 100, 'pay_abc123')
    await expect(pay(500_000, 100, 'pay_abc123')).rejects.toThrow(LedgerConflictError)
  })

  it('orders history by time', async () => {
    await charge(1_000_000, 0)
    await pay(100_000, 300)
    await pay(200_000, 100)

    const history = await ledger.history(CASE)
    expect(history.map((e) => e.at)).toEqual([0, 100, 300])
  })

  it('exposes no update or delete method', () => {
    const surface = Object.getOwnPropertyNames(LedgerRepository.prototype)
    expect(surface).not.toContain('update')
    expect(surface).not.toContain('delete')
  })

  it('classifies settlement state', async () => {
    await charge(1_000_000)
    expect(isSettled(await ledger.outstanding(CASE))).toBe(false)

    await pay(400_000, 10)
    const partial = await ledger.outstanding(CASE)
    expect(isSettled(partial)).toBe(false)
    expect(isPartiallySettled(partial, paise(1_000_000))).toBe(true)

    await pay(600_000, 20)
    const done = await ledger.outstanding(CASE)
    expect(isSettled(done)).toBe(true)
    expect(isPartiallySettled(done, paise(1_000_000))).toBe(false)
  })

  it('treats an overpayment as settled rather than negative debt owed', async () => {
    await charge(1_000_000)
    await pay(1_200_000, 10)
    const outstanding = await ledger.outstanding(CASE)
    expect(outstanding).toBe(-200_000)
    expect(isSettled(outstanding)).toBe(true)
  })
})
