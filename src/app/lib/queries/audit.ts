import { eq } from 'drizzle-orm'

import { auditRecords } from '../../../db/schema'
import { consoleDb, MERCHANT_ID } from './connection'

export interface AuditSummary {
  readonly records: number
  readonly firstAt: number | undefined
  readonly lastAt: number | undefined
}

export async function auditSummary(): Promise<AuditSummary> {
  const db = await consoleDb()
  const rows = await db
    .select({ at: auditRecords.at })
    .from(auditRecords)
    .where(eq(auditRecords.merchantId, MERCHANT_ID))

  const times = rows.map((row) => row.at).sort((a, b) => a - b)
  return { records: rows.length, firstAt: times[0], lastAt: times.at(-1) }
}
