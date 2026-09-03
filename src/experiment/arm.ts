import { sha256 } from '../core/canonical-hash'
import type { Paise } from '../core/money'
import type { Arm, FailureClass } from '../domain/enums'

export const AMOUNT_BANDS = ['micro', 'low', 'mid', 'high', 'enterprise'] as const
export type AmountBand = (typeof AMOUNT_BANDS)[number]

const BAND_CEILINGS: readonly (readonly [AmountBand, number])[] = [
  ['micro', 50_000],
  ['low', 500_000],
  ['mid', 2_500_000],
  ['high', 10_000_000],
]

export function amountBand(amountPaise: Paise): AmountBand {
  for (const [band, ceiling] of BAND_CEILINGS) {
    if (amountPaise < ceiling) return band
  }
  return 'enterprise'
}

export function stratumKey(amountPaise: Paise, failureClass: FailureClass | 'UNKNOWN'): string {
  return `${amountBand(amountPaise)}|${failureClass}`
}

export interface AssignerOptions {
  readonly treatmentShare?: number
}

const DEFAULT_TREATMENT_SHARE = 0.8
const HASH_BUCKETS = 10_000

export class StratifiedAssigner {
  private readonly salt: string
  private readonly treatmentShare: number
  private readonly counts = new Map<string, { TREATMENT: number; CONTROL: number }>()

  constructor(salt: string, options: AssignerOptions = {}) {
    const share = options.treatmentShare ?? DEFAULT_TREATMENT_SHARE
    if (share <= 0 || share >= 1) {
      throw new RangeError(`treatment share must be strictly between 0 and 1, got ${share}`)
    }
    this.salt = salt
    this.treatmentShare = share
  }

  assign(stratum: string, caseKey: string): Arm {
    const digest = sha256(`${this.salt}|${stratum}|${caseKey}`)
    const bucket = Number.parseInt(digest.slice(0, 8), 16) % HASH_BUCKETS
    const arm: Arm = bucket < this.treatmentShare * HASH_BUCKETS ? 'TREATMENT' : 'CONTROL'

    const tally = this.counts.get(stratum) ?? { TREATMENT: 0, CONTROL: 0 }
    tally[arm] += 1
    this.counts.set(stratum, tally)

    return arm
  }

  tally(stratum: string): { TREATMENT: number; CONTROL: number } {
    return this.counts.get(stratum) ?? { TREATMENT: 0, CONTROL: 0 }
  }

  strata(): string[] {
    return [...this.counts.keys()].sort()
  }

  totals(): { TREATMENT: number; CONTROL: number } {
    const total = { TREATMENT: 0, CONTROL: 0 }
    for (const tally of this.counts.values()) {
      total.TREATMENT += tally.TREATMENT
      total.CONTROL += tally.CONTROL
    }
    return total
  }
}
