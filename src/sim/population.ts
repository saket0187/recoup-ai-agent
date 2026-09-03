import { addIstDays, startOfIstDay } from '../core/calendar'
import type { IdFactory } from '../core/identifiers'
import { paise, type Paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import {
  PORTFOLIOS,
  type CaseType,
  type Channel,
  type Language,
  type PaymentMethod,
  type Portfolio,
} from '../domain/enums'
import { ARCHETYPES, type Archetype } from './hidden/archetypes'
import {
  createDynamicState,
  generateLatentState,
  type LatentCustomerState,
  type LatentDynamicState,
} from './hidden/latent'

const PORTFOLIO_WEIGHTS: readonly (readonly [Portfolio, number])[] = [
  ['d2c_subscription', 45],
  ['one_time_checkout', 35],
  ['b2b_invoice', 20],
]

interface AmountProfile {
  readonly logMean: number
  readonly logSpread: number
  readonly minPaise: number
  readonly maxPaise: number
}

const AMOUNT_PROFILES: Readonly<Record<Portfolio, AmountProfile>> = {
  d2c_subscription: {
    logMean: Math.log(59_900),
    logSpread: 0.75,
    minPaise: 9_900,
    maxPaise: 999_900,
  },
  one_time_checkout: {
    logMean: Math.log(180_000),
    logSpread: 0.95,
    minPaise: 20_000,
    maxPaise: 5_000_000,
  },
  b2b_invoice: {
    logMean: Math.log(9_500_000),
    logSpread: 1.05,
    minPaise: 500_000,
    maxPaise: 250_000_000,
  },
}

const CASE_TYPE_BY_PORTFOLIO: Readonly<Record<Portfolio, CaseType>> = {
  d2c_subscription: 'SUBSCRIPTION_DUNNING',
  one_time_checkout: 'FAILED_PAYMENT',
  b2b_invoice: 'INVOICE_OVERDUE',
}

const CONTACTABLE_CHANNELS: readonly Channel[] = ['SMS', 'WHATSAPP', 'EMAIL', 'VOICE']

export interface SimConsent {
  readonly channel: Channel
  readonly granted: boolean
  readonly dnd: boolean
  readonly purpose: string
  readonly source: string
}

export interface SimObligation {
  readonly id: string
  readonly type: CaseType
  readonly amountPaise: Paise
  readonly dueAt: number
  readonly method: PaymentMethod
  readonly issuer: string
  readonly orderId: string | undefined
  readonly subscriptionId: string | undefined
  readonly invoiceId: string | undefined
}

export interface SimAccount {
  readonly id: string
  readonly mandateCapPaise: number | null
  readonly merchantId: string
  readonly externalRef: string
  readonly priorBillsSettled: number
  readonly priorBillsPaid: number
  readonly portfolio: Portfolio
  readonly languagePref: Language
  readonly timezone: string
  readonly consents: readonly SimConsent[]
  readonly obligations: readonly SimObligation[]
  readonly latent: LatentCustomerState
  readonly dynamic: LatentDynamicState
}

export interface PopulationOptions {
  readonly merchantId: string
  readonly count: number
  readonly startAt: number
  readonly durationDays: number
  readonly portfolioWeights?: readonly (readonly [Portfolio, number])[]
}

const WITHIN_ACCOUNT_SPREAD = 0.25

function clampToProfile(portfolio: Portfolio, raw: number): Paise {
  const profile = AMOUNT_PROFILES[portfolio]
  const clamped = Math.min(profile.maxPaise, Math.max(profile.minPaise, raw))
  return paise(Math.round(clamped / 100) * 100)
}

function drawAccountScale(rng: Rng, portfolio: Portfolio): Paise {
  const profile = AMOUNT_PROFILES[portfolio]
  return clampToProfile(portfolio, Math.exp(rng.normal(profile.logMean, profile.logSpread)))
}

function drawAmount(rng: Rng, portfolio: Portfolio, scalePaise: Paise): Paise {
  return clampToProfile(portfolio, scalePaise * Math.exp(rng.normal(0, WITHIN_ACCOUNT_SPREAD)))
}

function generateConsents(rng: Rng, latent: LatentCustomerState): SimConsent[] {
  const dnd = rng.bool(0.18)
  return CONTACTABLE_CHANNELS.map((channel) => {
    const grantRate = channel === 'EMAIL' ? 0.95 : channel === 'VOICE' ? 0.62 : 0.88
    return {
      channel,
      granted: latent.behaviour.wrongNumber ? rng.bool(grantRate * 0.5) : rng.bool(grantRate),
      dnd: channel === 'SMS' || channel === 'VOICE' ? dnd : false,
      purpose: 'payment_recovery',
      source: 'checkout_terms',
    }
  })
}

function generateObligations(
  rng: Rng,
  ids: IdFactory,
  portfolio: Portfolio,
  latent: LatentCustomerState,
  scalePaise: Paise,
  options: PopulationOptions,
): SimObligation[] {
  const type = CASE_TYPE_BY_PORTFOLIO[portfolio]
  const { method, issuer } = latent.instrument
  const windowStart = startOfIstDay(options.startAt)

  if (portfolio === 'd2c_subscription') {
    const subscriptionId = ids.next('sub')
    const anchorDay = rng.int(0, 30)
    const cycles = Math.max(1, Math.floor((options.durationDays - anchorDay) / 30) + 1)
    return Array.from({ length: cycles }, (_, cycle) => ({
      id: ids.next('obl'),
      type,
      amountPaise: drawAmount(rng, portfolio, scalePaise),
      dueAt: addIstDays(windowStart, anchorDay + cycle * 30) + rng.int(0, 24) * 3_600_000,
      method,
      issuer,
      orderId: undefined,
      subscriptionId,
      invoiceId: undefined,
    }))
  }

  if (portfolio === 'b2b_invoice') {
    const count = rng.int(1, 4)
    return Array.from({ length: count }, () => ({
      id: ids.next('obl'),
      type,
      amountPaise: drawAmount(rng, portfolio, scalePaise),
      dueAt: addIstDays(windowStart, rng.int(0, Math.max(1, options.durationDays - 10))),
      method,
      issuer,
      orderId: undefined,
      subscriptionId: undefined,
      invoiceId: ids.next('inv'),
    }))
  }

  return [
    {
      id: ids.next('obl'),
      type,
      amountPaise: drawAmount(rng, portfolio, scalePaise),
      dueAt:
        addIstDays(windowStart, rng.int(0, Math.max(1, options.durationDays - 5))) +
        rng.int(0, 24) * 3_600_000,
      method,
      issuer,
      orderId: ids.next('order'),
      subscriptionId: undefined,
      invoiceId: undefined,
    },
  ]
}

export function generatePopulation(
  rng: Rng,
  ids: IdFactory,
  options: PopulationOptions,
): SimAccount[] {
  if (options.count <= 0) {
    throw new RangeError(`generatePopulation: count must be positive, got ${options.count}`)
  }

  const portfolioRng = rng.derive('portfolio')
  const scaleRng = rng.derive('scale')
  const latentRng = rng.derive('latent')
  const consentRng = rng.derive('consent')
  const obligationRng = rng.derive('obligation')
  const historyRng = rng.derive('history')
  const weights = options.portfolioWeights ?? PORTFOLIO_WEIGHTS

  return Array.from({ length: options.count }, (_, index) => {
    const portfolio = portfolioRng.weighted(weights)
    const scalePaise = drawAccountScale(scaleRng, portfolio)
    const latent = generateLatentState(latentRng, portfolio, options.startAt, scalePaise)

    const history = generatePriorHistory(historyRng, latent)

    return {
      id: ids.next('cust'),
      priorBillsSettled: history.settled,
      priorBillsPaid: history.paid,
      mandateCapPaise: latent.instrument.mandateCapPaise,
      merchantId: options.merchantId,
      externalRef: `acct-${String(index + 1).padStart(6, '0')}`,
      portfolio,
      languagePref: latent.languagePref,
      timezone: 'Asia/Kolkata',
      consents: generateConsents(consentRng, latent),
      obligations: generateObligations(obligationRng, ids, portfolio, latent, scalePaise, options),
      latent,
      dynamic: createDynamicState(),
    }
  })
}

const MAX_PRIOR_BILLS = 11

function generatePriorHistory(
  rng: Rng,
  latent: LatentCustomerState,
): { settled: number; paid: number } {
  const settled = rng.int(0, MAX_PRIOR_BILLS)
  if (settled === 0) return { settled: 0, paid: 0 }

  const reliability = latent.behaviour.promisesThenBreaks
    ? 0.35
    : latent.behaviour.disputesInvoice
      ? 0.55
      : Math.min(0.98, 0.45 + latent.willingness * 0.55)

  let paid = 0
  for (let bill = 0; bill < settled; bill++) {
    if (rng.bool(reliability)) paid++
  }

  return { settled, paid }
}

export interface PopulationSummary {
  readonly count: number
  readonly byPortfolio: Readonly<Record<Portfolio, number>>
  readonly byArchetype: Readonly<Record<Archetype, number>>
  readonly obligations: number
  readonly totalAtRiskPaise: Paise
}

export function summarisePopulation(accounts: readonly SimAccount[]): PopulationSummary {
  const byPortfolio = Object.fromEntries(PORTFOLIOS.map((p) => [p, 0])) as Record<Portfolio, number>
  const byArchetype = Object.fromEntries(ARCHETYPES.map((a) => [a, 0])) as Record<Archetype, number>
  let obligations = 0
  let total = 0

  for (const account of accounts) {
    byPortfolio[account.portfolio] += 1
    byArchetype[account.latent.archetype] += 1
    obligations += account.obligations.length
    for (const obligation of account.obligations) total += obligation.amountPaise
  }

  return {
    count: accounts.length,
    byPortfolio,
    byArchetype,
    obligations,
    totalAtRiskPaise: paise(total),
  }
}
