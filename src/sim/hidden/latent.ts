import { isMonthEnd, isSalaryWindow, istDayOfMonth } from '../../core/calendar'
import { paise, type Paise } from '../../core/money'
import type { Rng } from '../../core/seeded-random'
import type { Channel, Language, PaymentMethod, Portfolio } from '../../domain/enums'
import { archetypeWeights, profileFor, type Archetype, type ArchetypeBehaviour } from './archetypes'

export type MandateStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'PAUSED' | 'NONE'

export interface InstrumentHealth {
  readonly method: PaymentMethod
  readonly issuer: string
  readonly cardExpiresAt: number | null
  readonly mandateStatus: MandateStatus
  readonly mandateCapPaise: Paise | null
  readonly vpaValid: boolean
}

export interface LatentCustomerState {
  readonly archetype: Archetype
  readonly behaviour: ArchetypeBehaviour
  readonly abilityBase: number
  readonly willingness: number
  readonly forgetfulness: number
  readonly channelResponsiveness: Readonly<Record<Channel, number>>
  readonly annoyanceThreshold: number
  readonly cancellationPropensity: number
  readonly replyPropensity: number
  readonly instrument: InstrumentHealth
  readonly b2bPayDays: readonly number[]
  readonly b2bProcessLagDays: number
  readonly tdsRatePct: number | null
  readonly languagePref: Language
}

export interface LatentDynamicState {
  annoyanceAccrued: number
  optedOut: boolean
  cancelled: boolean
  promisesMade: number
  promisesBroken: number
  lastContactAt: number | null
}

const ISSUER_WEIGHTS: readonly (readonly [string, number])[] = [
  ['HDFC', 22],
  ['ICICI', 18],
  ['SBI', 20],
  ['AXIS', 12],
  ['KOTAK', 9],
  ['PNB', 8],
  ['BOB', 6],
  ['YES', 5],
]

const METHOD_WEIGHTS: Readonly<Record<Portfolio, readonly (readonly [PaymentMethod, number])[]>> = {
  d2c_subscription: [
    ['upi', 55],
    ['emandate', 28],
    ['card', 17],
  ],
  one_time_checkout: [
    ['upi', 62],
    ['card', 22],
    ['netbanking', 11],
    ['wallet', 5],
  ],
  b2b_invoice: [
    ['netbanking', 58],
    ['nach', 30],
    ['upi', 12],
  ],
}

const LANGUAGE_WEIGHTS: readonly (readonly [Language, number])[] = [
  ['hinglish', 46],
  ['en', 38],
  ['hi', 16],
]

const TDS_RATES_PCT = [1, 2, 10] as const

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function drawAround(rng: Rng, mean: number, spread: number): number {
  return clamp01(rng.normal(mean, spread))
}

function pickArchetype(rng: Rng, portfolio: Portfolio): Archetype {
  return rng.weighted(archetypeWeights(portfolio))
}

const UNDER_PROVISIONED_MANDATE_SHARE = 0.04

function drawMandateCap(rng: Rng, typicalAmountPaise: Paise): Paise {
  const multiplier = rng.bool(UNDER_PROVISIONED_MANDATE_SHARE)
    ? 0.5 + rng.next() * 0.4
    : 2 + rng.next() * 18
  return paise(Math.max(100, Math.round((typicalAmountPaise * multiplier) / 100) * 100))
}

function generateInstrument(
  rng: Rng,
  portfolio: Portfolio,
  archetype: Archetype,
  now: number,
  typicalAmountPaise: Paise,
): InstrumentHealth {
  const method = rng.weighted(METHOD_WEIGHTS[portfolio])
  const issuer = rng.weighted(ISSUER_WEIGHTS)

  const usesMandate = method === 'emandate' || method === 'nach' || portfolio === 'd2c_subscription'

  const mandateStatus: MandateStatus = usesMandate
    ? rng.weighted([
        ['ACTIVE', 88],
        ['REVOKED', 5],
        ['EXPIRED', 4],
        ['PAUSED', 3],
      ] as const)
    : 'NONE'

  const cardExpiresAt = method === 'card' ? now + rng.int(-30, 900) * 86_400_000 : null

  const vpaValid = method === 'upi' ? rng.bool(archetype === 'WRONG_NUMBER' ? 0.72 : 0.94) : true

  return {
    method,
    issuer,
    cardExpiresAt,
    mandateStatus,
    mandateCapPaise: usesMandate ? drawMandateCap(rng, typicalAmountPaise) : null,
    vpaValid,
  }
}

function generateChannelResponsiveness(rng: Rng, base: number): Record<Channel, number> {
  const jitter = (centre: number): number => clamp01(rng.normal(centre, 0.16))
  return {
    SMS: jitter(base * 0.7),
    WHATSAPP: jitter(base * 1.15),
    EMAIL: jitter(base * 0.55),
    VOICE: jitter(base * 0.9),
    IN_APP: jitter(base * 0.8),
    HUMAN: jitter(base * 1.3),
  }
}

export function generateLatentState(
  rng: Rng,
  portfolio: Portfolio,
  now: number,
  typicalAmountPaise: Paise,
  archetype = pickArchetype(rng, portfolio),
): LatentCustomerState {
  const profile = profileFor(archetype)
  const { latent, behaviour } = profile

  const abilityBase = drawAround(rng, latent.abilityMean, latent.abilitySpread)
  const willingness = drawAround(rng, latent.willingnessMean, latent.willingnessSpread)
  const responsivenessBase = clamp01(rng.normal(latent.replyPropensityMean, 0.18))

  const payDays = behaviour.fixedPayCycle
    ? rng.pick([[15, 30], [10, 25], [7, 21], [30]] as const)
    : []

  return {
    archetype,
    behaviour,
    abilityBase,
    willingness,
    forgetfulness: drawAround(rng, latent.forgetfulnessMean, 0.18),
    channelResponsiveness: generateChannelResponsiveness(rng, responsivenessBase),
    annoyanceThreshold: Math.max(1, Math.round(rng.normal(latent.annoyanceThresholdMean, 1.4))),
    cancellationPropensity: drawAround(rng, latent.cancellationPropensityMean, 0.06),
    replyPropensity: responsivenessBase,
    instrument: generateInstrument(rng, portfolio, archetype, now, typicalAmountPaise),
    b2bPayDays: payDays,
    b2bProcessLagDays: behaviour.fixedPayCycle ? rng.int(2, 12) : 0,
    tdsRatePct: behaviour.deductsTds ? rng.pick(TDS_RATES_PCT) : null,
    languagePref: rng.weighted(LANGUAGE_WEIGHTS),
  }
}

export function createDynamicState(): LatentDynamicState {
  return {
    annoyanceAccrued: 0,
    optedOut: false,
    cancelled: false,
    promisesMade: 0,
    promisesBroken: 0,
    lastContactAt: null,
  }
}

export function abilityAt(latent: LatentCustomerState, at: number): number {
  let ability = latent.abilityBase

  if (isSalaryWindow(at)) ability += 0.22
  if (isMonthEnd(at)) ability -= 0.14

  if (latent.behaviour.fixedPayCycle && latent.b2bPayDays.length > 0) {
    const day = istDayOfMonth(at)
    const onCycle = latent.b2bPayDays.some((payDay) => day >= payDay && day <= payDay + 2)
    ability = onCycle ? ability + 0.3 : ability - 0.25
  }

  return clamp01(ability)
}

export function isInstrumentUsable(instrument: InstrumentHealth, at: number): boolean {
  if (instrument.mandateStatus === 'REVOKED' || instrument.mandateStatus === 'EXPIRED') return false
  if (instrument.method === 'upi' && !instrument.vpaValid) return false
  if (instrument.cardExpiresAt !== null && instrument.cardExpiresAt < at) return false
  return true
}
