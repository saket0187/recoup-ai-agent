import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VirtualClock } from '../src/core/clock'
import type { DatabaseHandle } from '../src/db/client'
import { customers, riskCases } from '../src/db/schema'
import { TemporalLeakError, assertTemporallySafe, temporalCutoff } from '../src/db/temporal-cutoff'
import { createTestDatabase, seedMerchant } from './helpers/database'

const MERCHANT = 'merch_test'
const CUSTOMER = 'cust_1'

async function insertCase(
  handle: DatabaseHandle,
  id: string,
  resolvedAt: number | null,
): Promise<void> {
  await handle.db.insert(riskCases).values({
    id,
    merchantId: MERCHANT,
    customerId: CUSTOMER,
    type: 'FAILED_PAYMENT',
    amountPaise: 100_000,
    currency: 'INR',
    dueAt: 0,
    sourceEntity: { paymentId: `pay_${id}` },
    state: resolvedAt === null ? 'OPEN' : 'RECOVERED',
    arm: 'TREATMENT',
    stratum: 'mid|FUNDS_TIMING',
    policyVersion: '2026.08.28-1',
    firstSeenAt: 0,
    resolvedAt,
    updatedAt: 0,
  })
}

describe('temporalCutoff', () => {
  let handle: DatabaseHandle

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle, MERCHANT)
    await handle.db.insert(customers).values({
      id: CUSTOMER,
      merchantId: MERCHANT,
      externalRef: 'ext_1',
      portfolio: 'd2c_subscription',
      createdAt: 0,
    })
  })

  afterEach(() => {
    handle.close()
  })

  it('returns only cases resolved strictly before the clock', async () => {
    await insertCase(handle, 'case_past', 500)
    await insertCase(handle, 'case_now', 1_000)
    await insertCase(handle, 'case_future', 5_000)
    await insertCase(handle, 'case_open', null)

    const clock = new VirtualClock({ start: 1_000 })
    const rows = await handle.db
      .select()
      .from(riskCases)
      .where(temporalCutoff(clock, riskCases.resolvedAt))

    expect(rows.map((r) => r.id)).toEqual(['case_past'])
  })

  it('widens the visible set as the clock advances', async () => {
    await insertCase(handle, 'case_a', 500)
    await insertCase(handle, 'case_b', 2_000)
    await insertCase(handle, 'case_c', 9_000)

    const clock = new VirtualClock({ start: 1_000 })

    const early = await handle.db
      .select()
      .from(riskCases)
      .where(temporalCutoff(clock, riskCases.resolvedAt))
    expect(early).toHaveLength(1)

    await clock.advanceTo(5_000)

    const later = await handle.db
      .select()
      .from(riskCases)
      .where(temporalCutoff(clock, riskCases.resolvedAt))
    expect(later.map((r) => r.id).sort()).toEqual(['case_a', 'case_b'])
  })

  it('never returns an unresolved case', async () => {
    await insertCase(handle, 'case_open', null)

    const clock = new VirtualClock({ start: Number.MAX_SAFE_INTEGER })
    const rows = await handle.db
      .select()
      .from(riskCases)
      .where(temporalCutoff(clock, riskCases.resolvedAt))

    expect(rows).toEqual([])
  })
})

describe('assertTemporallySafe', () => {
  const clock = new VirtualClock({ start: 1_000 })

  it('passes rows that all precede the cutoff', () => {
    expect(() =>
      assertTemporallySafe(
        clock,
        [{ resolvedAt: 100 }, { resolvedAt: 999 }],
        'resolvedAt',
        'retrieval',
      ),
    ).not.toThrow()
  })

  it('throws on a row at the cutoff, because that outcome is not yet known', () => {
    expect(() =>
      assertTemporallySafe(clock, [{ resolvedAt: 1_000 }], 'resolvedAt', 'case retrieval'),
    ).toThrow(TemporalLeakError)
  })

  it('throws on a row after the cutoff and says why it matters', () => {
    expect(() =>
      assertTemporallySafe(clock, [{ resolvedAt: 5_000 }], 'resolvedAt', 'case retrieval'),
    ).toThrow(/time-travelling oracle/)
  })

  it('throws on a null timestamp rather than assuming it is safe', () => {
    expect(() =>
      assertTemporallySafe(clock, [{ resolvedAt: null }], 'resolvedAt', 'case retrieval'),
    ).toThrow(TemporalLeakError)
  })

  it('throws when the column is not a timestamp', () => {
    expect(() =>
      assertTemporallySafe(clock, [{ resolvedAt: 'yesterday' }], 'resolvedAt', 'case retrieval'),
    ).toThrow(/epoch timestamp/)
  })

  it('accepts an empty result set', () => {
    expect(() => assertTemporallySafe(clock, [], 'resolvedAt', 'case retrieval')).not.toThrow()
  })
})
