import { and, asc, eq, sql } from 'drizzle-orm'

import { GENESIS_HASH, hashRecord } from '../core/canonical-hash'
import type { Clock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import { KeyedMutex } from '../core/keyed-mutex'
import type { AuditEntryType } from '../domain/enums'
import type { Database } from './client'
import { auditRecords, type AuditRecord } from './schema'

export interface AuditAppendInput {
  readonly merchantId: string
  readonly entryType: AuditEntryType
  readonly actor: string
  readonly payload: unknown
  readonly caseId?: string
  readonly subjectId?: string
}

interface HashableRecord {
  merchantId: string
  seq: number
  at: number
  entryType: AuditEntryType
  caseId: string | null
  subjectId: string | null
  actor: string
  payload: unknown
}

export interface ChainBreak {
  readonly seq: number
  readonly id: string
  readonly expectedHash: string
  readonly storedHash: string
  readonly expectedPrevHash: string
  readonly storedPrevHash: string
}

export interface VerifyResult {
  readonly merchantId: string
  readonly recordsChecked: number
  readonly intact: boolean
  readonly firstBreak: ChainBreak | undefined
}

export class AuditIntegrityError extends Error {
  override readonly name = 'AuditIntegrityError'
}

function hashableOf(record: HashableRecord): HashableRecord {
  return {
    merchantId: record.merchantId,
    seq: record.seq,
    at: record.at,
    entryType: record.entryType,
    caseId: record.caseId,
    subjectId: record.subjectId,
    actor: record.actor,
    payload: record.payload,
  }
}

const APPEND_RETRIES = 5

function isSequenceConflict(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  const nested = cause.cause instanceof Error ? cause.cause.message : ''
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(`${cause.message} ${nested}`)
}

export class AuditChain {
  private readonly db: Database
  private readonly clock: Clock
  private readonly ids: IdFactory
  private readonly writes = new KeyedMutex()

  constructor(db: Database, clock: Clock, ids: IdFactory) {
    this.db = db
    this.clock = clock
    this.ids = ids
  }

  append(input: AuditAppendInput): Promise<AuditRecord> {
    return this.writes.run(input.merchantId, () => this.appendWithRetry(input))
  }

  private async appendWithRetry(input: AuditAppendInput): Promise<AuditRecord> {
    let lastError: unknown
    for (let attempt = 0; attempt < APPEND_RETRIES; attempt++) {
      try {
        return await this.appendUnsafe(input)
      } catch (cause) {
        if (!isSequenceConflict(cause)) throw cause
        lastError = cause
      }
    }
    throw new AuditIntegrityError(
      `Could not append to the chain for merchant ${input.merchantId} after ${APPEND_RETRIES} ` +
        `attempts: another writer keeps winning the sequence. Cause: ` +
        `${lastError instanceof Error ? lastError.message : 'unknown'}`,
    )
  }

  private async appendUnsafe(input: AuditAppendInput): Promise<AuditRecord> {
    const head = await this.db
      .select({ seq: auditRecords.seq, hash: auditRecords.hash })
      .from(auditRecords)
      .where(eq(auditRecords.merchantId, input.merchantId))
      .orderBy(sql`${auditRecords.seq} desc`)
      .limit(1)

    const previous = head[0]

    if (previous === undefined) {
      await this.writeRecord(
        {
          merchantId: input.merchantId,
          seq: 0,
          at: this.clock.now(),
          entryType: 'GENESIS',
          caseId: null,
          subjectId: null,
          actor: 'system',
          payload: { merchantId: input.merchantId },
        },
        GENESIS_HASH,
      )
    }

    const currentHead =
      previous ??
      (
        await this.db
          .select({ seq: auditRecords.seq, hash: auditRecords.hash })
          .from(auditRecords)
          .where(eq(auditRecords.merchantId, input.merchantId))
          .orderBy(sql`${auditRecords.seq} desc`)
          .limit(1)
      )[0]

    if (currentHead === undefined) {
      throw new AuditIntegrityError(
        `Genesis record for merchant ${input.merchantId} was written but cannot be read back.`,
      )
    }

    return this.writeRecord(
      {
        merchantId: input.merchantId,
        seq: currentHead.seq + 1,
        at: this.clock.now(),
        entryType: input.entryType,
        caseId: input.caseId ?? null,
        subjectId: input.subjectId ?? null,
        actor: input.actor,
        payload: input.payload,
      },
      currentHead.hash,
    )
  }

  private async writeRecord(record: HashableRecord, prevHash: string): Promise<AuditRecord> {
    const hash = hashRecord(prevHash, hashableOf(record))
    const row = {
      id: this.ids.next('audit'),
      merchantId: record.merchantId,
      seq: record.seq,
      at: record.at,
      entryType: record.entryType,
      caseId: record.caseId,
      subjectId: record.subjectId,
      actor: record.actor,
      payload: record.payload,
      prevHash,
      hash,
    }
    await this.db.insert(auditRecords).values(row)
    return row
  }

  async read(merchantId: string, options: { caseId?: string } = {}): Promise<AuditRecord[]> {
    const filter =
      options.caseId === undefined
        ? eq(auditRecords.merchantId, merchantId)
        : and(eq(auditRecords.merchantId, merchantId), eq(auditRecords.caseId, options.caseId))

    return this.db.select().from(auditRecords).where(filter).orderBy(asc(auditRecords.seq))
  }

  async verify(merchantId: string): Promise<VerifyResult> {
    const rows = await this.db
      .select()
      .from(auditRecords)
      .where(eq(auditRecords.merchantId, merchantId))
      .orderBy(asc(auditRecords.seq))

    let expectedPrevHash = GENESIS_HASH

    for (const [index, row] of rows.entries()) {
      if (row.seq !== index) {
        return {
          merchantId,
          recordsChecked: index,
          intact: false,
          firstBreak: {
            seq: row.seq,
            id: row.id,
            expectedHash: `seq ${index}`,
            storedHash: `seq ${row.seq}`,
            expectedPrevHash,
            storedPrevHash: row.prevHash,
          },
        }
      }

      const expectedHash = hashRecord(expectedPrevHash, hashableOf(row))

      if (expectedHash !== row.hash || expectedPrevHash !== row.prevHash) {
        return {
          merchantId,
          recordsChecked: index,
          intact: false,
          firstBreak: {
            seq: row.seq,
            id: row.id,
            expectedHash,
            storedHash: row.hash,
            expectedPrevHash,
            storedPrevHash: row.prevHash,
          },
        }
      }

      expectedPrevHash = row.hash
    }

    return { merchantId, recordsChecked: rows.length, intact: true, firstBreak: undefined }
  }

  async listMerchants(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ merchantId: auditRecords.merchantId })
      .from(auditRecords)
    return rows.map((row) => row.merchantId)
  }
}

export function renderChainBreak(result: VerifyResult): string {
  const { firstBreak } = result
  if (firstBreak === undefined) {
    return `merchant ${result.merchantId}: chain intact across ${result.recordsChecked} records`
  }
  return [
    `merchant ${result.merchantId}: chain BROKEN at seq ${firstBreak.seq} (record ${firstBreak.id})`,
    `  expected prev_hash ${firstBreak.expectedPrevHash}`,
    `  stored   prev_hash ${firstBreak.storedPrevHash}`,
    `  expected hash      ${firstBreak.expectedHash}`,
    `  stored   hash      ${firstBreak.storedHash}`,
    `  ${result.recordsChecked} record(s) verified before the break`,
  ].join('\n')
}
