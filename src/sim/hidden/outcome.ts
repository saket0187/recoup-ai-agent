import { isBankingDay } from '../../core/calendar'
import type { Paise } from '../../core/money'
import type { Rng } from '../../core/seeded-random'
import type { ActionType, Channel, PaymentMethod, Portfolio } from '../../domain/enums'
import { downtimeSeverity, type WorldState } from '../world'
import {
  abilityAt,
  isInstrumentUsable,
  type LatentCustomerState,
  type LatentDynamicState,
} from './latent'

const DAILY_PAYMENT_HAZARD = 0.09
const AWARENESS_DECAY_DAYS = 14
const REACH_MULTIPLIER = 2.2
const MAX_OPT_OUT_HAZARD = 0.16
const BASELINE_CANCELLATION_HAZARD = 0.01
const DUNNING_CANCELLATION_HAZARD = 0.06

const METHOD_AUTHORISATION_RATE: Readonly<Record<PaymentMethod, number>> = {
  upi: 0.58,
  card: 0.44,
  netbanking: 0.52,
  wallet: 0.5,
  emandate: 0.62,
  nach: 0.56,
}

const RETRY_FATIGUE_PER_ATTEMPT = 0.85

interface ActionEffect {
  readonly forcesAwareness: boolean
  readonly abilityMultiplier: number
  readonly willingnessMultiplier: number
  readonly repairsInstrument: number
}

const NEUTRAL: ActionEffect = {
  forcesAwareness: false,
  abilityMultiplier: 1,
  willingnessMultiplier: 1,
  repairsInstrument: 0,
}

const ACTION_EFFECTS: Partial<Record<ActionType, ActionEffect>> = {
  SEND_NUDGE: { ...NEUTRAL, forcesAwareness: true },
  SEND_PAYMENT_LINK: { ...NEUTRAL, forcesAwareness: true, willingnessMultiplier: 1.15 },
  SEND_PRE_DEBIT_NOTICE: { ...NEUTRAL, forcesAwareness: true, abilityMultiplier: 1.2 },
  OFFER_METHOD_SWITCH: { ...NEUTRAL, forcesAwareness: true, repairsInstrument: 0.35 },
  REQUEST_INSTRUMENT_UPDATE: { ...NEUTRAL, forcesAwareness: true, repairsInstrument: 0.42 },
  MANDATE_REPAIR: { ...NEUTRAL, forcesAwareness: true, repairsInstrument: 0.5 },
  OFFER_PART_PAYMENT: { ...NEUTRAL, forcesAwareness: true, abilityMultiplier: 1.4 },
  OFFER_PLAN: { ...NEUTRAL, forcesAwareness: true, abilityMultiplier: 1.5 },
  OFFER_DISCOUNT: { ...NEUTRAL, forcesAwareness: true, willingnessMultiplier: 1.35 },
  GRANT_EXTENSION: { ...NEUTRAL, forcesAwareness: true, abilityMultiplier: 1.1 },
  ESCALATE_CONTACT: { ...NEUTRAL, forcesAwareness: true, willingnessMultiplier: 1.12 },
  ESCALATE_HUMAN: { ...NEUTRAL, forcesAwareness: true, willingnessMultiplier: 1.25 },
}

const CONTACT_ACTIONS = new Set<ActionType>(
  Object.entries(ACTION_EFFECTS)
    .filter(([, effect]) => effect?.forcesAwareness === true)
    .map(([action]) => action as ActionType),
)

const CHARGE_ACTIONS = new Set<ActionType>([
  'RETRY_CHARGE',
  'RETRY_CHARGE_ALT_ROUTE',
  'SPLIT_RETRY',
])

export interface OutcomeContext {
  readonly at: number
  readonly latent: LatentCustomerState
  readonly dynamic: LatentDynamicState
  readonly world: WorldState
  readonly portfolio: Portfolio
  readonly amountPaise: Paise
  readonly daysSinceDue: number
  readonly touchCount: number
  readonly attemptCount: number
  readonly hasActivePromise: boolean
  readonly bankHolidays: ReadonlySet<string>
}

export interface OutcomeProbabilities {
  readonly payment: number
  readonly reply: number
  readonly optOut: number
  readonly cancellation: number
}

export interface SampledOutcome {
  readonly paid: boolean
  readonly replied: boolean
  readonly optedOut: boolean
  readonly cancelled: boolean
  readonly probabilities: OutcomeProbabilities
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function passiveAwareness(latent: LatentCustomerState, daysSinceDue: number): number {
  return clamp01(1 - latent.forgetfulness * Math.exp(-daysSinceDue / AWARENESS_DECAY_DAYS))
}

function channelReach(latent: LatentCustomerState, channel: Channel | undefined): number {
  if (channel === undefined) return 0
  return clamp01((latent.channelResponsiveness[channel] ?? 0) * REACH_MULTIPLIER)
}

function overContactRatio(context: OutcomeContext): number {
  return clamp01(context.touchCount / Math.max(1, context.latent.annoyanceThreshold))
}

function chargeSuccessProbability(context: OutcomeContext, action: ActionType): number {
  const { latent, world, at, bankHolidays } = context
  const { instrument } = latent

  if (!isInstrumentUsable(instrument, at)) return 0

  const settlesOnBankingDaysOnly = instrument.method === 'nach' || instrument.method === 'emandate'
  if (settlesOnBankingDaysOnly && !isBankingDay(at, bankHolidays)) return 0

  const severity = downtimeSeverity(world, instrument.method, instrument.issuer)
  if (severity >= 1) return 0

  const base = METHOD_AUTHORISATION_RATE[instrument.method]
  const ability = abilityAt(latent, at)
  const fatigue = Math.pow(RETRY_FATIGUE_PER_ATTEMPT, context.attemptCount)
  const splitRelief = action === 'SPLIT_RETRY' ? 1.3 : 1

  return clamp01(base * ability * fatigue * splitRelief * (1 - severity))
}

function contactPaymentProbability(
  context: OutcomeContext,
  action: ActionType,
  channel: Channel | undefined,
): number {
  const { latent, at, daysSinceDue } = context
  const effect = ACTION_EFFECTS[action] ?? NEUTRAL

  const reach = channelReach(latent, channel)
  const awareness = effect.forcesAwareness
    ? Math.max(passiveAwareness(latent, daysSinceDue), reach)
    : passiveAwareness(latent, daysSinceDue)

  const ability = clamp01(abilityAt(latent, at) * effect.abilityMultiplier)
  const willingness = clamp01(latent.willingness * effect.willingnessMultiplier)

  const instrumentOk = isInstrumentUsable(latent.instrument, at) ? 1 : effect.repairsInstrument

  const fatigue = 1 - 0.45 * overContactRatio(context)

  return clamp01(DAILY_PAYMENT_HAZARD * awareness * ability * willingness * instrumentOk * fatigue)
}

function optOutProbability(context: OutcomeContext, contacted: boolean): number {
  if (!contacted) return 0
  const { latent } = context
  const excess = context.touchCount - latent.annoyanceThreshold
  const pressure = 1 / (1 + Math.exp(-excess / 1.5))
  const abusiveBoost = latent.behaviour.abusive ? 1.6 : 1
  const vulnerableBoost = latent.behaviour.vulnerable ? 1.4 : 1
  return clamp01(MAX_OPT_OUT_HAZARD * pressure * abusiveBoost * vulnerableBoost)
}

function cancellationProbability(context: OutcomeContext, contacted: boolean): number {
  if (context.portfolio === 'b2b_invoice') return 0

  const pressure = contacted ? overContactRatio(context) : 0
  const hazard = BASELINE_CANCELLATION_HAZARD + DUNNING_CANCELLATION_HAZARD * pressure
  return clamp01(context.latent.cancellationPropensity * hazard)
}

function replyProbability(
  context: OutcomeContext,
  contacted: boolean,
  channel: Channel | undefined,
): number {
  if (!contacted) return 0
  const { latent } = context
  const base = latent.channelResponsiveness[channel ?? 'SMS'] ?? 0
  const fatigue = 1 - 0.3 * overContactRatio(context)
  const talkative =
    latent.behaviour.promisesThenBreaks || latent.behaviour.disputesInvoice ? 1.5 : 1
  return clamp01(base * fatigue * talkative)
}

export function outcomeProbabilities(
  context: OutcomeContext,
  action: ActionType,
  channel?: Channel,
): OutcomeProbabilities {
  if (context.dynamic.cancelled || context.dynamic.optedOut) {
    return { payment: 0, reply: 0, optOut: 0, cancellation: 0 }
  }

  const contacted = CONTACT_ACTIONS.has(action)

  const payment = CHARGE_ACTIONS.has(action)
    ? chargeSuccessProbability(context, action)
    : contactPaymentProbability(context, action, channel)

  return {
    payment,
    reply: replyProbability(context, contacted, channel),
    optOut: optOutProbability(context, contacted),
    cancellation: cancellationProbability(context, contacted),
  }
}

export function sampleOutcome(
  rng: Rng,
  context: OutcomeContext,
  action: ActionType,
  channel?: Channel,
): SampledOutcome {
  const probabilities = outcomeProbabilities(context, action, channel)
  const paid = rng.bool(probabilities.payment)

  return {
    paid,
    replied: !paid && rng.bool(probabilities.reply),
    optedOut: !paid && rng.bool(probabilities.optOut),
    cancelled: !paid && rng.bool(probabilities.cancellation),
    probabilities,
  }
}

export function registerContact(
  dynamic: LatentDynamicState,
  latent: LatentCustomerState,
  channel: Channel,
  at: number,
): void {
  const intrusiveness = channel === 'VOICE' ? 1.6 : channel === 'EMAIL' ? 0.5 : 1
  dynamic.annoyanceAccrued += intrusiveness / Math.max(1, latent.annoyanceThreshold)
  dynamic.lastContactAt = at
}
