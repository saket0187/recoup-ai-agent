import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { VirtualClock } from '../src/core/clock'
import { GENESIS_HASH } from '../src/core/canonical-hash'
import { createIdFactory } from '../src/core/identifiers'
import { AuditChain, renderChainBreak } from '../src/db/audit-chain'
import type { DatabaseHandle } from '../src/db/client'
import { auditRecords } from '../src/db/schema'
import { createTestDatabase, seedMerchant } from './helpers/database'

describe('AuditChain', () => {
  let handle: DatabaseHandle
  let clock: VirtualClock
  let chain: AuditChain
  let merchantId: string

  beforeEach(async () => {
    handle = await createTestDatabase()
    merchantId = await seedMerchant(handle)
    clock = new VirtualClock({ start: 1_000 })
    chain = new AuditChain(handle.db, clock, createIdFactory('test'))
  })

  afterEach(() => {
    handle.close()
  })

  it('writes a genesis record before the first entry', async () => {
    await chain.append({
      merchantId,
      entryType: 'CASE_OPENED',
      actor: 'engine',
      payload: { caseId: 'case_1' },
    })

    const records = await chain.read(merchantId)
    expect(records).toHaveLength(2)
    expect(records[0]?.entryType).toBe('GENESIS')
    expect(records[0]?.seq).toBe(0)
    expect(records[0]?.prevHash).toBe(GENESIS_HASH)
    expect(records[1]?.entryType).toBe('CASE_OPENED')
    expect(records[1]?.seq).toBe(1)
  })

  it('links each record to the previous hash', async () => {
    for (let i = 0; i < 5; i++) {
      await chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: { i } })
    }

    const records = await chain.read(merchantId)
    for (let i = 1; i < records.length; i++) {
      expect(records[i]?.prevHash).toBe(records[i - 1]?.hash)
    }
  })

  it('timestamps from the injected clock, not wall time', async () => {
    await clock.advanceTo(9_999)
    const record = await chain.append({
      merchantId,
      entryType: 'DECISION',
      actor: 'engine',
      payload: {},
    })
    expect(record.at).toBe(9_999)
  })

  it('verifies an intact chain', async () => {
    for (let i = 0; i < 10; i++) {
      await chain.append({ merchantId, entryType: 'LEDGER_EVENT', actor: 'engine', payload: { i } })
    }

    const result = await chain.verify(merchantId)
    expect(result.intact).toBe(true)
    expect(result.recordsChecked).toBe(11)
    expect(result.firstBreak).toBeUndefined()
    expect(renderChainBreak(result)).toMatch(/chain intact across 11 records/)
  })

  it('detects a mutated payload and names the first broken record', async () => {
    for (let i = 0; i < 5; i++) {
      await chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: { i } })
    }

    const records = await chain.read(merchantId)
    const target = records[3]
    expect(target).toBeDefined()

    await handle.db
      .update(auditRecords)
      .set({ payload: { i: 999 } })
      .where(eq(auditRecords.id, target?.id ?? ''))

    const result = await chain.verify(merchantId)
    expect(result.intact).toBe(false)
    expect(result.firstBreak?.seq).toBe(3)
    expect(result.recordsChecked).toBe(3)
    expect(renderChainBreak(result)).toMatch(/chain BROKEN at seq 3/)
  })

  it('detects a mutated actor even when the payload is untouched', async () => {
    await chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: {} })
    const records = await chain.read(merchantId)

    await handle.db
      .update(auditRecords)
      .set({ actor: 'someone_else' })
      .where(eq(auditRecords.id, records[1]?.id ?? ''))

    expect((await chain.verify(merchantId)).intact).toBe(false)
  })

  it('detects a relinked prev_hash', async () => {
    for (let i = 0; i < 4; i++) {
      await chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: { i } })
    }
    const records = await chain.read(merchantId)

    await handle.db
      .update(auditRecords)
      .set({ prevHash: GENESIS_HASH })
      .where(eq(auditRecords.id, records[2]?.id ?? ''))

    const result = await chain.verify(merchantId)
    expect(result.intact).toBe(false)
    expect(result.firstBreak?.seq).toBe(2)
  })

  it('detects a deleted record through the sequence gap', async () => {
    for (let i = 0; i < 4; i++) {
      await chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: { i } })
    }
    const records = await chain.read(merchantId)

    await handle.db.delete(auditRecords).where(eq(auditRecords.id, records[2]?.id ?? ''))

    const result = await chain.verify(merchantId)
    expect(result.intact).toBe(false)
  })

  it('keeps merchants on independent chains', async () => {
    const other = await seedMerchant(handle, 'merch_other')

    await chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: { a: 1 } })
    await chain.append({
      merchantId: other,
      entryType: 'DECISION',
      actor: 'engine',
      payload: { b: 2 },
    })

    expect(await chain.read(merchantId)).toHaveLength(2)
    expect(await chain.read(other)).toHaveLength(2)
    expect((await chain.verify(merchantId)).intact).toBe(true)
    expect((await chain.verify(other)).intact).toBe(true)
    expect((await chain.listMerchants()).sort()).toEqual([other, merchantId].sort())
  })

  it('serialises concurrent appends into a gap-free sequence', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        chain.append({ merchantId, entryType: 'DECISION', actor: 'engine', payload: { i } }),
      ),
    )

    const records = await chain.read(merchantId)
    expect(records).toHaveLength(26)
    expect(records.map((r) => r.seq)).toEqual(Array.from({ length: 26 }, (_, i) => i))
    expect((await chain.verify(merchantId)).intact).toBe(true)
  })

  it('filters a read to one case', async () => {
    await chain.append({
      merchantId,
      entryType: 'DECISION',
      actor: 'engine',
      caseId: 'case_a',
      payload: {},
    })
    await chain.append({
      merchantId,
      entryType: 'DECISION',
      actor: 'engine',
      caseId: 'case_b',
      payload: {},
    })

    const forCase = await chain.read(merchantId, { caseId: 'case_a' })
    expect(forCase).toHaveLength(1)
    expect(forCase[0]?.caseId).toBe('case_a')
  })

  it('exposes no update or delete method', () => {
    const surface = Object.getOwnPropertyNames(AuditChain.prototype)
    expect(surface).not.toContain('update')
    expect(surface).not.toContain('delete')
    expect(surface).not.toContain('remove')
  })
})

describe('the hash covers what the decision row shows', () => {
  it('names every field the console renders from a decision', () => {
    const covered = new Set([
      'chosenAction',
      'chosenChannel',
      'chosenBy',
      'propensity',
      'finalVerdict',
      'candidates',
      'featureSnapshot',
      'modelVersion',
      'reviewerVerdict',
      'reviewerReason',
      'deferUntil',
      'suppressReason',
      'policyVersion',
      'playbookVersion',
      'policyEvaluations',
      'stopEvaluations',
    ])

    const source = readFileSync('src/engine/orchestrator.ts', 'utf8')
    const payload = source.slice(
      source.indexOf("entryType: 'DECISION'"),
      source.indexOf('await this.options.db.batch'),
    )

    for (const field of covered) {
      const declared = new RegExp(`\\b${field}\\s*[,:]`)
      expect(declared.test(payload), `${field} is outside the audit payload`).toBe(true)
    }
  })

  it('covers the candidate numbers a reader would want to falsify', () => {
    const source = readFileSync('src/engine/orchestrator.ts', 'utf8')
    const payload = source.slice(
      source.indexOf("entryType: 'DECISION'"),
      source.indexOf('await this.options.db.batch'),
    )
    for (const field of ['pSuccess', 'costPaise', 'rationale', 'evPaise', 'uplift']) {
      const declared = new RegExp(`\\b${field}\\s*[,:]`)
      expect(declared.test(payload), `candidate ${field} is outside the hash`).toBe(true)
    }
  })
})
