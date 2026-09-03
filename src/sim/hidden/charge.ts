import type { Paise } from '../../core/money'
import type { Rng } from '../../core/seeded-random'
import type { PaymentMethod } from '../../domain/enums'
import { isCohortDown } from '../world'
import type { SimFailureCause } from '../error-signatures'
import { abilityAt, type LatentCustomerState } from './latent'
import { outcomeProbabilities, type OutcomeContext } from './outcome'

export interface ChargeAttemptResult {
  readonly succeeded: boolean
  readonly cause: SimFailureCause | null
  readonly successProbability: number
}

type CauseWeights = Partial<Record<SimFailureCause, number>>

const CUSTOMER_PRESENT_CAUSES: Readonly<Record<PaymentMethod, CauseWeights>> = {
  card: { OTP_FAILED: 16, USER_CANCELLED: 8, CARD_BLOCKED: 3 },
  netbanking: { OTP_FAILED: 6, USER_CANCELLED: 9 },
  upi: { OTP_FAILED: 3, USER_CANCELLED: 10 },
  wallet: { USER_CANCELLED: 8 },
  emandate: {},
  nach: {},
}

const ALWAYS_POSSIBLE_CAUSES: CauseWeights = {
  RISK_DECLINE: 5,
  GATEWAY_ERROR: 6,
  UNKNOWN: 2,
}

function pickFailureCause(rng: Rng, latent: LatentCustomerState, at: number): SimFailureCause {
  const ability = abilityAt(latent, at)

  const weights: CauseWeights = {
    INSUFFICIENT_FUNDS: 40 * (1 - ability) + 4,
    LIMIT_EXCEEDED: 6 * (1 - ability) + 1,
    ...ALWAYS_POSSIBLE_CAUSES,
    ...CUSTOMER_PRESENT_CAUSES[latent.instrument.method],
  }

  return rng.weighted(
    Object.entries(weights).map(([cause, weight]) => [cause as SimFailureCause, weight] as const),
  )
}

export function attemptCharge(
  rng: Rng,
  context: OutcomeContext,
  amountPaise: Paise,
): ChargeAttemptResult {
  const { latent, world, at } = context

  if (world.merchantDefect !== undefined) {
    return { succeeded: false, cause: 'MERCHANT_DEFECT', successProbability: 0 }
  }

  if (isCohortDown(world, latent.instrument.method, latent.instrument.issuer)) {
    return { succeeded: false, cause: 'DOWNTIME', successProbability: 0 }
  }

  const { instrument } = latent

  if (instrument.mandateStatus === 'REVOKED' || instrument.mandateStatus === 'EXPIRED') {
    return { succeeded: false, cause: 'MANDATE_REVOKED', successProbability: 0 }
  }

  if (instrument.mandateCapPaise !== null && amountPaise > instrument.mandateCapPaise) {
    return { succeeded: false, cause: 'MANDATE_CAP_EXCEEDED', successProbability: 0 }
  }

  if (instrument.cardExpiresAt !== null && instrument.cardExpiresAt < at) {
    return { succeeded: false, cause: 'CARD_EXPIRED', successProbability: 0 }
  }

  if (instrument.method === 'upi' && !instrument.vpaValid) {
    return { succeeded: false, cause: 'VPA_INVALID', successProbability: 0 }
  }

  const successProbability = outcomeProbabilities(context, 'RETRY_CHARGE').payment

  if (rng.bool(successProbability)) {
    return { succeeded: true, cause: null, successProbability }
  }

  return { succeeded: false, cause: pickFailureCause(rng, latent, at), successProbability }
}
