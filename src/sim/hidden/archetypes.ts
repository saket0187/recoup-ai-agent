import type { Portfolio } from '../../domain/enums'

export const ARCHETYPES = [
  'ORDINARY',
  'SERIAL_PROMISER',
  'DISPUTER',
  'INJECTOR',
  'ABUSIVE',
  'VULNERABLE',
  'WRONG_NUMBER',
  'TDS_DEDUCTOR',
  'AP_CLERK',
] as const

export type Archetype = (typeof ARCHETYPES)[number]

export interface ArchetypeBehaviour {
  readonly promisesThenBreaks: boolean
  readonly disputesInvoice: boolean
  readonly attemptsInjection: boolean
  readonly abusive: boolean
  readonly vulnerable: boolean
  readonly wrongNumber: boolean
  readonly deductsTds: boolean
  readonly fixedPayCycle: boolean
}

export interface LatentModifiers {
  readonly abilityMean: number
  readonly abilitySpread: number
  readonly willingnessMean: number
  readonly willingnessSpread: number
  readonly forgetfulnessMean: number
  readonly annoyanceThresholdMean: number
  readonly cancellationPropensityMean: number
  readonly replyPropensityMean: number
}

export interface ArchetypeProfile {
  readonly id: Archetype
  readonly weight: number
  readonly portfolios: readonly Portfolio[]
  readonly behaviour: ArchetypeBehaviour
  readonly latent: LatentModifiers
}

const ALL_PORTFOLIOS: readonly Portfolio[] = [
  'd2c_subscription',
  'one_time_checkout',
  'b2b_invoice',
]

const NO_BEHAVIOUR: ArchetypeBehaviour = {
  promisesThenBreaks: false,
  disputesInvoice: false,
  attemptsInjection: false,
  abusive: false,
  vulnerable: false,
  wrongNumber: false,
  deductsTds: false,
  fixedPayCycle: false,
}

const ARCHETYPE_PROFILES: readonly ArchetypeProfile[] = [
  {
    id: 'ORDINARY',
    weight: 62,
    portfolios: ALL_PORTFOLIOS,
    behaviour: NO_BEHAVIOUR,
    latent: {
      abilityMean: 0.62,
      abilitySpread: 0.22,
      willingnessMean: 0.68,
      willingnessSpread: 0.24,
      forgetfulnessMean: 0.55,
      annoyanceThresholdMean: 4.5,
      cancellationPropensityMean: 0.06,
      replyPropensityMean: 0.28,
    },
  },
  {
    id: 'SERIAL_PROMISER',
    weight: 6,
    portfolios: ALL_PORTFOLIOS,
    behaviour: { ...NO_BEHAVIOUR, promisesThenBreaks: true },
    latent: {
      abilityMean: 0.34,
      abilitySpread: 0.18,
      willingnessMean: 0.72,
      willingnessSpread: 0.14,
      forgetfulnessMean: 0.3,
      annoyanceThresholdMean: 7,
      cancellationPropensityMean: 0.04,
      replyPropensityMean: 0.72,
    },
  },
  {
    id: 'DISPUTER',
    weight: 5,
    portfolios: ALL_PORTFOLIOS,
    behaviour: { ...NO_BEHAVIOUR, disputesInvoice: true },
    latent: {
      abilityMean: 0.7,
      abilitySpread: 0.2,
      willingnessMean: 0.28,
      willingnessSpread: 0.16,
      forgetfulnessMean: 0.15,
      annoyanceThresholdMean: 3,
      cancellationPropensityMean: 0.14,
      replyPropensityMean: 0.68,
    },
  },
  {
    id: 'INJECTOR',
    weight: 2,
    portfolios: ALL_PORTFOLIOS,
    behaviour: { ...NO_BEHAVIOUR, attemptsInjection: true },
    latent: {
      abilityMean: 0.5,
      abilitySpread: 0.25,
      willingnessMean: 0.25,
      willingnessSpread: 0.2,
      forgetfulnessMean: 0.2,
      annoyanceThresholdMean: 6,
      cancellationPropensityMean: 0.1,
      replyPropensityMean: 0.85,
    },
  },
  {
    id: 'ABUSIVE',
    weight: 2,
    portfolios: ALL_PORTFOLIOS,
    behaviour: { ...NO_BEHAVIOUR, abusive: true },
    latent: {
      abilityMean: 0.4,
      abilitySpread: 0.22,
      willingnessMean: 0.22,
      willingnessSpread: 0.16,
      forgetfulnessMean: 0.2,
      annoyanceThresholdMean: 1.5,
      cancellationPropensityMean: 0.24,
      replyPropensityMean: 0.6,
    },
  },
  {
    id: 'VULNERABLE',
    weight: 3,
    portfolios: ALL_PORTFOLIOS,
    behaviour: { ...NO_BEHAVIOUR, vulnerable: true },
    latent: {
      abilityMean: 0.14,
      abilitySpread: 0.1,
      willingnessMean: 0.62,
      willingnessSpread: 0.2,
      forgetfulnessMean: 0.25,
      annoyanceThresholdMean: 2,
      cancellationPropensityMean: 0.3,
      replyPropensityMean: 0.42,
    },
  },
  {
    id: 'WRONG_NUMBER',
    weight: 3,
    portfolios: ALL_PORTFOLIOS,
    behaviour: { ...NO_BEHAVIOUR, wrongNumber: true },
    latent: {
      abilityMean: 0.5,
      abilitySpread: 0.25,
      willingnessMean: 0.5,
      willingnessSpread: 0.25,
      forgetfulnessMean: 0.4,
      annoyanceThresholdMean: 2.5,
      cancellationPropensityMean: 0.05,
      replyPropensityMean: 0.35,
    },
  },
  {
    id: 'TDS_DEDUCTOR',
    weight: 22,
    portfolios: ['b2b_invoice'],
    behaviour: { ...NO_BEHAVIOUR, deductsTds: true, fixedPayCycle: true },
    latent: {
      abilityMean: 0.82,
      abilitySpread: 0.12,
      willingnessMean: 0.85,
      willingnessSpread: 0.1,
      forgetfulnessMean: 0.2,
      annoyanceThresholdMean: 5,
      cancellationPropensityMean: 0.02,
      replyPropensityMean: 0.45,
    },
  },
  {
    id: 'AP_CLERK',
    weight: 20,
    portfolios: ['b2b_invoice'],
    behaviour: { ...NO_BEHAVIOUR, fixedPayCycle: true },
    latent: {
      abilityMean: 0.86,
      abilitySpread: 0.1,
      willingnessMean: 0.8,
      willingnessSpread: 0.12,
      forgetfulnessMean: 0.5,
      annoyanceThresholdMean: 6,
      cancellationPropensityMean: 0.02,
      replyPropensityMean: 0.5,
    },
  },
]

export function profilesForPortfolio(portfolio: Portfolio): readonly ArchetypeProfile[] {
  return ARCHETYPE_PROFILES.filter((profile) => profile.portfolios.includes(portfolio))
}

export function archetypeWeights(portfolio: Portfolio): readonly (readonly [Archetype, number])[] {
  return profilesForPortfolio(portfolio).map((profile) => [profile.id, profile.weight] as const)
}

export function profileFor(archetype: Archetype): ArchetypeProfile {
  const profile = ARCHETYPE_PROFILES.find((candidate) => candidate.id === archetype)
  if (profile === undefined) {
    throw new RangeError(`Unknown archetype: ${archetype}`)
  }
  return profile
}
