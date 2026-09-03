import { sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

import type { Clock } from '../core/clock'

export function temporalCutoff(clock: Clock, column: SQLiteColumn): SQL<unknown> {
  const cutoff = clock.now()
  return sql`${column} is not null and ${column} < ${cutoff}`
}

export class TemporalLeakError extends Error {
  override readonly name = 'TemporalLeakError'
}

export function assertTemporallySafe<T extends Record<string, unknown>>(
  clock: Clock,
  rows: readonly T[],
  key: keyof T & string,
  context: string,
): void {
  const cutoff = clock.now()
  for (const row of rows) {
    const value = row[key]
    if (value === null || value === undefined) {
      throw new TemporalLeakError(
        `${context}: row has no ${key}, so it cannot be proven to precede the cutoff (${cutoff}).`,
      )
    }
    if (typeof value !== 'number') {
      throw new TemporalLeakError(
        `${context}: ${key} must be an epoch timestamp, got ${typeof value}.`,
      )
    }
    if (value >= cutoff) {
      throw new TemporalLeakError(
        `${context}: retrieved a row with ${key}=${value} at or after the cutoff (${cutoff}). ` +
          `This is a time-travelling oracle; every metric downstream of it is void.`,
      )
    }
  }
}
