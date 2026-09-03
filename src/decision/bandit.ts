import { istDayOfMonth, istHour, istWeekday } from '../core/calendar'
import type { Rng } from '../core/seeded-random'
import type { ActionType, FailureClass, PaymentMethod } from '../domain/enums'

export interface BetaPosterior {
  readonly alpha: number
  readonly beta: number
}

export interface ArmKey {
  readonly action: ActionType
  readonly method: PaymentMethod | undefined
  readonly issuer: string | undefined
  readonly dayBucket: string
  readonly hourSlot: number
  readonly failureClass: FailureClass
  readonly attemptBucket: string
}

export function attemptBucketOf(attempts: number): string {
  if (attempts <= 0) return 'first'
  if (attempts === 1) return 'second'
  if (attempts === 2) return 'third'
  return 'later'
}

const CHARGE_PRIOR: BetaPosterior = { alpha: 2, beta: 8 }
const CONTACT_PRIOR: BetaPosterior = { alpha: 1.5, beta: 10 }
const OFFER_PRIOR: BetaPosterior = { alpha: 2.5, beta: 8 }
const WAIT_PRIOR: BetaPosterior = { alpha: 1, beta: 12 }

const PRIOR_BY_ACTION: Partial<Record<ActionType, BetaPosterior>> = {
  RETRY_CHARGE: CHARGE_PRIOR,
  RETRY_CHARGE_ALT_ROUTE: CHARGE_PRIOR,
  SPLIT_RETRY: CHARGE_PRIOR,
  SEND_NUDGE: CONTACT_PRIOR,
  SEND_PAYMENT_LINK: CONTACT_PRIOR,
  SEND_PRE_DEBIT_NOTICE: CONTACT_PRIOR,
  ESCALATE_CONTACT: CONTACT_PRIOR,
  REQUEST_INSTRUMENT_UPDATE: CONTACT_PRIOR,
  MANDATE_REPAIR: CONTACT_PRIOR,
  OFFER_METHOD_SWITCH: CONTACT_PRIOR,
  OFFER_PART_PAYMENT: OFFER_PRIOR,
  OFFER_PLAN: OFFER_PRIOR,
  OFFER_DISCOUNT: OFFER_PRIOR,
  GRANT_EXTENSION: OFFER_PRIOR,
  ESCALATE_HUMAN: OFFER_PRIOR,
  WAIT: WAIT_PRIOR,
}

export function dayBucketOf(at: number): string {
  const day = istDayOfMonth(at)
  if (day <= 5) return 'salary'
  if (day >= 26) return 'month_end'
  return istWeekday(at) === 0 || istWeekday(at) === 6 ? 'weekend' : 'mid_month'
}

export function hourSlotOf(at: number): number {
  return Math.floor(istHour(at) / 4)
}

export function priorForArmKey(armKey: string): BetaPosterior {
  const action = armKey.split('|')[0] as ActionType
  return PRIOR_BY_ACTION[action] ?? CONTACT_PRIOR
}

export function armKeyOf(key: ArmKey): string {
  return [
    key.action,
    key.method ?? 'any',
    key.issuer ?? 'any',
    key.dayBucket,
    key.hourSlot,
    key.failureClass,
    key.attemptBucket,
  ].join('|')
}

export interface ArmCounts {
  readonly successes: number
  readonly failures: number
}

export class ThompsonBandit {
  private readonly rng: Rng
  private readonly posteriors = new Map<string, { alpha: number; beta: number }>()
  private readonly pending = new Map<string, { successes: number; failures: number }>()

  constructor(rng: Rng) {
    this.rng = rng
  }

  restore(
    counts: ReadonlyMap<string, ArmCounts>,
    priorFor: (armKey: string) => BetaPosterior,
  ): void {
    for (const [armKey, observed] of counts) {
      const prior = priorFor(armKey)
      this.posteriors.set(armKey, {
        alpha: prior.alpha + observed.successes,
        beta: prior.beta + observed.failures,
      })
    }
  }

  drainPending(): ReadonlyMap<string, ArmCounts> {
    const drained = new Map<string, ArmCounts>(this.pending)
    this.pending.clear()
    return drained
  }

  private priorFor(action: ActionType): BetaPosterior {
    return PRIOR_BY_ACTION[action] ?? CONTACT_PRIOR
  }

  posterior(key: ArmKey): BetaPosterior {
    const stored = this.posteriors.get(armKeyOf(key))
    return stored ?? this.priorFor(key.action)
  }

  sample(key: ArmKey): number {
    const { alpha, beta } = this.posterior(key)
    return this.rng.beta(alpha, beta)
  }

  mean(key: ArmKey): number {
    const { alpha, beta } = this.posterior(key)
    return alpha / (alpha + beta)
  }

  update(key: ArmKey, succeeded: boolean): void {
    const id = armKeyOf(key)
    const current = this.posteriors.get(id) ?? { ...this.priorFor(key.action) }
    if (succeeded) current.alpha += 1
    else current.beta += 1
    this.posteriors.set(id, current)

    const delta = this.pending.get(id) ?? { successes: 0, failures: 0 }
    if (succeeded) delta.successes += 1
    else delta.failures += 1
    this.pending.set(id, delta)
  }

  observations(key: ArmKey): number {
    const prior = this.priorFor(key.action)
    const { alpha, beta } = this.posterior(key)
    return alpha - prior.alpha + (beta - prior.beta)
  }

  size(): number {
    return this.posteriors.size
  }

  snapshot(): Record<string, BetaPosterior> {
    return Object.fromEntries([...this.posteriors.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  }
}
