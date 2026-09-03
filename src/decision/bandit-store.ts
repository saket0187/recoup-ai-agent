import { eq, sql } from 'drizzle-orm'

import type { Database } from '../db/client'
import { banditArms } from '../db/schema'
import { priorForArmKey, type ArmCounts, type ThompsonBandit } from './bandit'

export class BanditStore {
  private readonly db: Database
  private readonly merchantId: string

  constructor(db: Database, merchantId: string) {
    this.db = db
    this.merchantId = merchantId
  }

  async load(bandit: ThompsonBandit): Promise<number> {
    const rows = await this.db
      .select()
      .from(banditArms)
      .where(eq(banditArms.merchantId, this.merchantId))

    const counts = new Map<string, ArmCounts>(
      rows.map((row) => [row.armKey, { successes: row.successes, failures: row.failures }]),
    )
    bandit.restore(counts, priorForArmKey)
    return counts.size
  }

  async flush(bandit: ThompsonBandit, at: number): Promise<number> {
    const pending = bandit.drainPending()
    if (pending.size === 0) return 0

    for (const [armKey, delta] of pending) {
      await this.db
        .insert(banditArms)
        .values({
          merchantId: this.merchantId,
          armKey,
          successes: delta.successes,
          failures: delta.failures,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [banditArms.merchantId, banditArms.armKey],
          set: {
            successes: sql`${banditArms.successes} + ${delta.successes}`,
            failures: sql`${banditArms.failures} + ${delta.failures}`,
            updatedAt: at,
          },
        })
    }

    return pending.size
  }
}
