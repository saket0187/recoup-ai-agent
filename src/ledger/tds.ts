import { paise, type Paise } from '../core/money'

export interface TdsSection {
  readonly section: string
  readonly ratePct: number
  readonly description: string
}

const KNOWN_TDS_SECTIONS: readonly TdsSection[] = [
  { section: '194Q', ratePct: 0.1, description: 'Purchase of goods' },
  { section: '194C-individual', ratePct: 1, description: 'Contractor, individual or HUF' },
  { section: '194C-company', ratePct: 2, description: 'Contractor, company' },
  { section: '194J-technical', ratePct: 2, description: 'Technical services' },
  { section: '194H', ratePct: 5, description: 'Commission or brokerage' },
  { section: '194J-professional', ratePct: 10, description: 'Professional services' },
  { section: '194I-equipment', ratePct: 2, description: 'Rent, plant and machinery' },
  { section: '194I-property', ratePct: 10, description: 'Rent, land or building' },
]

const GST_RATES_PCT: readonly number[] = [0, 5, 12, 18, 28]

export interface TdsMatch {
  readonly section: string
  readonly ratePct: number
  readonly gstRatePct: number
  readonly taxableBasePaise: Paise
  readonly expectedDeductionPaise: Paise
  readonly actualShortfallPaise: Paise
  readonly variancePaise: Paise
}

export interface TdsDetectionOptions {
  readonly tolerancePaise?: Paise
  readonly sections?: readonly TdsSection[]
  readonly gstRatesPct?: readonly number[]
}

const DEFAULT_TOLERANCE = paise(100)

export function detectTdsShortfall(
  invoicePaise: Paise,
  paidPaise: Paise,
  options: TdsDetectionOptions = {},
): TdsMatch | null {
  const shortfall = invoicePaise - paidPaise

  if (shortfall <= 0 || shortfall >= invoicePaise) return null

  const tolerance = options.tolerancePaise ?? DEFAULT_TOLERANCE
  const sections = options.sections ?? KNOWN_TDS_SECTIONS
  const gstRates = options.gstRatesPct ?? GST_RATES_PCT

  let best: TdsMatch | null = null

  for (const gstRatePct of gstRates) {
    const taxableBase = Math.round(invoicePaise / (1 + gstRatePct / 100))
    for (const { section, ratePct } of sections) {
      const expected = Math.round((taxableBase * ratePct) / 100)
      if (expected <= 0) continue
      const variance = Math.abs(shortfall - expected)
      if (variance > tolerance) continue
      if (best !== null && variance >= best.variancePaise) continue
      best = {
        section,
        ratePct,
        gstRatePct,
        taxableBasePaise: paise(taxableBase),
        expectedDeductionPaise: paise(expected),
        actualShortfallPaise: paise(shortfall),
        variancePaise: paise(variance),
      }
    }
  }

  return best
}

export function describeTdsMatch(match: TdsMatch): string {
  const gst = match.gstRatePct === 0 ? 'no GST' : `${match.gstRatePct}% GST`
  return `${match.section} at ${match.ratePct}% on the taxable value (${gst})`
}
