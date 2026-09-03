import { armKeyOf, type ArmKey, type ThompsonBandit } from './bandit'

export interface PendingAttribution {
  readonly key: ArmKey
  readonly caseId: string
  readonly at: number
}

export interface AttributionStats {
  readonly credited: number
  readonly expired: number
  readonly pending: number
}

export class AttributionTracker {
  private readonly bandit: ThompsonBandit
  private readonly windowMs: number
  private readonly pendingByCase = new Map<string, PendingAttribution[]>()

  private credited = 0
  private expired = 0

  constructor(bandit: ThompsonBandit, windowMs: number) {
    if (windowMs <= 0) throw new RangeError('attribution window must be positive')
    this.bandit = bandit
    this.windowMs = windowMs
  }

  record(key: ArmKey, caseId: string, at: number): void {
    const existing = this.pendingByCase.get(caseId) ?? []
    existing.push({ key, caseId, at })
    this.pendingByCase.set(caseId, existing)
  }

  creditRecovery(caseId: string, recoveredAt: number): number {
    const pending = this.pendingByCase.get(caseId)
    if (pending === undefined) return 0

    let credited = 0
    const remaining: PendingAttribution[] = []

    for (const entry of pending) {
      const withinWindow = recoveredAt >= entry.at && recoveredAt - entry.at <= this.windowMs
      if (withinWindow) {
        this.bandit.update(entry.key, true)
        credited++
      } else {
        remaining.push(entry)
      }
    }

    if (remaining.length === 0) this.pendingByCase.delete(caseId)
    else this.pendingByCase.set(caseId, remaining)

    this.credited += credited
    return credited
  }

  expire(now: number): number {
    let expired = 0

    for (const [caseId, pending] of this.pendingByCase) {
      const remaining = pending.filter((entry) => {
        if (now - entry.at <= this.windowMs) return true
        this.bandit.update(entry.key, false)
        expired++
        return false
      })

      if (remaining.length === 0) this.pendingByCase.delete(caseId)
      else this.pendingByCase.set(caseId, remaining)
    }

    this.expired += expired
    return expired
  }

  stats(): AttributionStats {
    let pending = 0
    for (const entries of this.pendingByCase.values()) pending += entries.length
    return { credited: this.credited, expired: this.expired, pending }
  }

  describePending(): string[] {
    return [...this.pendingByCase.values()]
      .flat()
      .map((entry) => `${entry.caseId}:${armKeyOf(entry.key)}`)
      .sort()
  }
}
