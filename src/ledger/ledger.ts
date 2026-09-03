import { and, asc, eq, lte, sql, type SQL } from 'drizzle-orm'

import type { IdFactory } from '../core/identifiers'
import { formatINR, paise, type Paise } from '../core/money'
import type { LedgerEventType } from '../domain/enums'
import type { Database } from '../db/client'
import { ledgerEvents, type LedgerEvent } from '../db/schema'

const SIGN_BY_TYPE: Record<LedgerEventType, 1 | -1> = {
  CHARGE: 1,
  REFUND: 1,
  PAYMENT: -1,
  CREDIT_NOTE: -1,
  TDS_ADJUSTMENT: -1,
  WRITE_OFF: -1,
}

export interface LedgerAppendInput {
  readonly caseId: string
  readonly merchantId: string
  readonly type: LedgerEventType
  readonly amountPaise: Paise
  readonly at: number
  readonly ref?: string
  readonly providerRef?: string
}

export class LedgerConflictError extends Error {
  override readonly name = 'LedgerConflictError'
}

export class LedgerRepository {
  private readonly db: Database
  private readonly ids: IdFactory

  constructor(db: Database, ids: IdFactory) {
    this.db = db
    this.ids = ids
  }

  async append(input: LedgerAppendInput): Promise<LedgerEvent> {
    if (input.amountPaise <= 0) {
      throw new RangeError(
        `LedgerRepository.append: amountPaise must be a positive magnitude, got ${input.amountPaise}. ` +
          `The sign is applied from the event type.`,
      )
    }

    if (input.providerRef !== undefined) {
      const existing = await this.findByProviderRef(input.providerRef)
      if (existing !== undefined) {
        const expected = SIGN_BY_TYPE[input.type] * input.amountPaise
        if (existing.amountPaise !== expected || existing.type !== input.type) {
          throw new LedgerConflictError(
            `Provider reference ${input.providerRef} already recorded as ${existing.type} ` +
              `${formatINR(paise(existing.amountPaise))}, now offered as ${input.type} ` +
              `${formatINR(paise(expected))}.`,
          )
        }
        return existing
      }
    }

    const row = {
      id: this.ids.next('ledger'),
      caseId: input.caseId,
      merchantId: input.merchantId,
      type: input.type,
      amountPaise: SIGN_BY_TYPE[input.type] * input.amountPaise,
      at: input.at,
      ref: input.ref ?? null,
      providerRef: input.providerRef ?? null,
      createdAt: input.at,
    }

    await this.db.insert(ledgerEvents).values(row)
    return row
  }

  async findByProviderRef(providerRef: string): Promise<LedgerEvent | undefined> {
    const rows = await this.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.providerRef, providerRef))
      .limit(1)
    return rows[0]
  }

  async outstanding(caseId: string): Promise<Paise> {
    return this.sumWhere(eq(ledgerEvents.caseId, caseId))
  }

  async outstandingAsOf(caseId: string, at: number): Promise<Paise> {
    return this.sumWhere(and(eq(ledgerEvents.caseId, caseId), lte(ledgerEvents.at, at)))
  }

  async totalPaidAsOf(caseId: string, at: number): Promise<Paise> {
    const settled = await this.sumWhere(
      and(
        eq(ledgerEvents.caseId, caseId),
        lte(ledgerEvents.at, at),
        eq(ledgerEvents.type, 'PAYMENT'),
      ),
    )
    return paise(0 - settled)
  }

  async history(caseId: string): Promise<LedgerEvent[]> {
    return this.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.caseId, caseId))
      .orderBy(asc(ledgerEvents.at), asc(ledgerEvents.id))
  }

  private async sumWhere(filter: SQL | undefined): Promise<Paise> {
    const rows = await this.db
      .select({ total: sql<number | null>`sum(${ledgerEvents.amountPaise})` })
      .from(ledgerEvents)
      .where(filter)
    return paise(rows[0]?.total ?? 0)
  }
}

export function isSettled(outstanding: Paise): boolean {
  return outstanding <= 0
}

export function isPartiallySettled(outstanding: Paise, original: Paise): boolean {
  return outstanding > 0 && outstanding < original
}
