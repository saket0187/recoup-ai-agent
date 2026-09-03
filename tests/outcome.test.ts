import { describe, expect, it } from 'vitest'

import { fromIst } from '../src/core/calendar'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import type { Channel } from '../src/domain/enums'
import type { LatentCustomerState, LatentDynamicState } from '../src/sim/hidden/latent'
import { createDynamicState } from '../src/sim/hidden/latent'
import {
  outcomeProbabilities,
  registerContact,
  sampleOutcome,
  type OutcomeContext,
} from '../src/sim/hidden/outcome'
import { parseWorldTimeline, worldStateAt } from '../src/sim/world'

const MIDWEEK = fromIst(2026, 9, 10, 12)
const SALARY_DAY = fromIst(2026, 9, 2, 12)
const SUNDAY = fromIst(2026, 9, 13, 12)

const CLEAR_WORLD = parseWorldTimeline(`
timezone: Asia/Kolkata
start_date: "2026-09-01"
duration_days: 30
events: []
`)

const OUTAGE_WORLD = parseWorldTimeline(`
timezone: Asia/Kolkata
start_date: "2026-09-01"
duration_days: 30
events:
  - kind: gateway_downtime
    name: HDFC UPI degradation
    method: upi
    issuer: HDFC
    start: day 10 11:00
    end: day 10 15:00
    severity: 1
`)

interface LatentOverrides {
  ability?: number
  willingness?: number
  forgetfulness?: number
  cancellationPropensity?: number
  annoyanceThreshold?: number
  responsiveness?: number
  method?: LatentCustomerState['instrument']['method']
  issuer?: string
  mandateStatus?: LatentCustomerState['instrument']['mandateStatus']
  cardExpiresAt?: number | null
  vpaValid?: boolean
}

function latent(overrides: LatentOverrides = {}): LatentCustomerState {
  const responsiveness = overrides.responsiveness ?? 0.5
  const channels: Record<Channel, number> = {
    SMS: responsiveness,
    WHATSAPP: responsiveness,
    EMAIL: responsiveness,
    VOICE: responsiveness,
    IN_APP: responsiveness,
    HUMAN: responsiveness,
  }

  return {
    archetype: 'ORDINARY',
    behaviour: {
      promisesThenBreaks: false,
      disputesInvoice: false,
      attemptsInjection: false,
      abusive: false,
      vulnerable: false,
      wrongNumber: false,
      deductsTds: false,
      fixedPayCycle: false,
    },
    abilityBase: overrides.ability ?? 0.8,
    willingness: overrides.willingness ?? 0.8,
    forgetfulness: overrides.forgetfulness ?? 0.5,
    channelResponsiveness: channels,
    annoyanceThreshold: overrides.annoyanceThreshold ?? 4,
    cancellationPropensity: overrides.cancellationPropensity ?? 0.1,
    replyPropensity: responsiveness,
    instrument: {
      method: overrides.method ?? 'upi',
      issuer: overrides.issuer ?? 'HDFC',
      cardExpiresAt: overrides.cardExpiresAt ?? null,
      mandateStatus: overrides.mandateStatus ?? 'ACTIVE',
      mandateCapPaise: null,
      vpaValid: overrides.vpaValid ?? true,
    },
    b2bPayDays: [],
    b2bProcessLagDays: 0,
    tdsRatePct: null,
    languagePref: 'en',
  }
}

function context(
  state: LatentCustomerState,
  overrides: Partial<OutcomeContext> = {},
  dynamic: LatentDynamicState = createDynamicState(),
): OutcomeContext {
  const at = overrides.at ?? MIDWEEK
  return {
    at,
    latent: state,
    dynamic,
    world: worldStateAt(CLEAR_WORLD, at),
    portfolio: 'd2c_subscription',
    amountPaise: paise(100_000),
    daysSinceDue: 1,
    touchCount: 0,
    attemptCount: 0,
    hasActivePromise: false,
    bankHolidays: new Set<string>(),
    ...overrides,
  }
}

const upliftOf = (ctx: OutcomeContext): number =>
  outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').payment -
  outcomeProbabilities(ctx, 'WAIT').payment

describe('uplift quadrants emerge from the latent parameters', () => {
  it('a persuadable (able, willing, but forgot) gains a lot from contact', () => {
    const uplift = upliftOf(
      context(latent({ ability: 0.85, willingness: 0.85, forgetfulness: 0.9 })),
    )
    expect(uplift).toBeGreaterThan(0.02)
  })

  it('a sure thing (already aware and able) gains almost nothing', () => {
    const uplift = upliftOf(
      context(latent({ ability: 0.9, willingness: 0.9, forgetfulness: 0.02 })),
    )
    expect(uplift).toBeLessThan(0.005)
  })

  it('a sure thing still pays at a high rate without any contact', () => {
    const passive = outcomeProbabilities(
      context(latent({ ability: 0.9, willingness: 0.9, forgetfulness: 0.02 })),
      'WAIT',
    ).payment
    expect(passive).toBeGreaterThan(0.06)
  })

  it('an unwilling lost cause gains little however it is contacted', () => {
    const uplift = upliftOf(
      context(latent({ ability: 0.8, willingness: 0.04, forgetfulness: 0.9 })),
    )
    expect(uplift).toBeLessThan(0.005)
  })

  it('ranks a persuadable above a sure thing and a lost cause', () => {
    const persuadable = upliftOf(
      context(latent({ ability: 0.85, willingness: 0.85, forgetfulness: 0.9 })),
    )
    const sureThing = upliftOf(
      context(latent({ ability: 0.9, willingness: 0.9, forgetfulness: 0.02 })),
    )
    const lostCause = upliftOf(
      context(latent({ ability: 0.8, willingness: 0.04, forgetfulness: 0.9 })),
    )

    expect(persuadable).toBeGreaterThan(sureThing)
    expect(persuadable).toBeGreaterThan(lostCause)
  })

  it('shrinks uplift as the customer notices on their own over time', () => {
    const state = latent({ forgetfulness: 0.9 })
    const early = upliftOf(context(state, { daysSinceDue: 1 }))
    const late = upliftOf(context(state, { daysSinceDue: 40 }))
    expect(late).toBeLessThan(early)
  })
})

describe('sleeping dogs', () => {
  it('contact raises cancellation risk above leaving them alone', () => {
    const ctx = context(latent({ cancellationPropensity: 0.8 }), { touchCount: 3 })
    const contacted = outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').cancellation
    const left = outcomeProbabilities(ctx, 'WAIT').cancellation

    expect(contacted).toBeGreaterThan(left)
  })

  it('keeps a baseline churn hazard with no contact at all, so the control arm churns too', () => {
    const ctx = context(latent({ cancellationPropensity: 0.8 }), { touchCount: 0 })
    expect(outcomeProbabilities(ctx, 'WAIT').cancellation).toBeGreaterThan(0)
  })

  it('cancellation risk climbs with over-contact', () => {
    const state = latent({ cancellationPropensity: 0.8, annoyanceThreshold: 4 })
    const light = outcomeProbabilities(context(state, { touchCount: 1 }), 'SEND_NUDGE', 'WHATSAPP')
    const heavy = outcomeProbabilities(context(state, { touchCount: 8 }), 'SEND_NUDGE', 'WHATSAPP')

    expect(heavy.cancellation).toBeGreaterThan(light.cancellation)
  })

  it('scales with the customer’s own propensity to churn', () => {
    const ctx = (propensity: number): OutcomeContext =>
      context(latent({ cancellationPropensity: propensity }), { touchCount: 4 })

    const loyal = outcomeProbabilities(ctx(0.01), 'SEND_NUDGE', 'WHATSAPP').cancellation
    const flighty = outcomeProbabilities(ctx(0.9), 'SEND_NUDGE', 'WHATSAPP').cancellation

    expect(flighty).toBeGreaterThan(loyal)
  })

  it('does not cancel a B2B invoice, which cannot be churned', () => {
    const ctx = context(latent({ cancellationPropensity: 0.9 }), {
      portfolio: 'b2b_invoice',
      touchCount: 8,
    })
    expect(outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').cancellation).toBe(0)
  })
})

describe('retry success', () => {
  it('is zero for the affected cohort during an outage', () => {
    const at = fromIst(2026, 9, 10, 12)
    const ctx = context(latent({ method: 'upi', issuer: 'HDFC' }), {
      at,
      world: worldStateAt(OUTAGE_WORLD, at),
    })
    expect(outcomeProbabilities(ctx, 'RETRY_CHARGE').payment).toBe(0)
  })

  it('leaves an unaffected cohort alone during the same outage', () => {
    const at = fromIst(2026, 9, 10, 12)
    const ctx = context(latent({ method: 'upi', issuer: 'ICICI' }), {
      at,
      world: worldStateAt(OUTAGE_WORLD, at),
    })
    expect(outcomeProbabilities(ctx, 'RETRY_CHARGE').payment).toBeGreaterThan(0)
  })

  it('is zero for a mandate-backed method on a non-banking day', () => {
    const ctx = context(latent({ method: 'nach' }), { at: SUNDAY })
    expect(outcomeProbabilities(ctx, 'RETRY_CHARGE').payment).toBe(0)
  })

  it('is zero when the instrument is dead', () => {
    expect(
      outcomeProbabilities(context(latent({ mandateStatus: 'REVOKED' })), 'RETRY_CHARGE').payment,
    ).toBe(0)
    expect(outcomeProbabilities(context(latent({ vpaValid: false })), 'RETRY_CHARGE').payment).toBe(
      0,
    )
    expect(
      outcomeProbabilities(
        context(latent({ method: 'card', cardExpiresAt: MIDWEEK - 1 })),
        'RETRY_CHARGE',
      ).payment,
    ).toBe(0)
  })

  it('decays with each prior attempt, since the easy wins go first', () => {
    const state = latent()
    const first = outcomeProbabilities(context(state, { attemptCount: 0 }), 'RETRY_CHARGE').payment
    const fourth = outcomeProbabilities(context(state, { attemptCount: 3 }), 'RETRY_CHARGE').payment
    expect(fourth).toBeLessThan(first)
    expect(fourth).toBeGreaterThan(0)
  })

  it('is higher inside the salary window', () => {
    const state = latent({ ability: 0.5 })
    const payday = outcomeProbabilities(context(state, { at: SALARY_DAY }), 'RETRY_CHARGE').payment
    const midweek = outcomeProbabilities(context(state, { at: MIDWEEK }), 'RETRY_CHARGE').payment
    expect(payday).toBeGreaterThan(midweek)
  })
})

describe('action effects', () => {
  it('a part-payment offer beats a plain nudge for someone short of money', () => {
    const ctx = context(latent({ ability: 0.25, willingness: 0.85, forgetfulness: 0.6 }))
    const nudge = outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').payment
    const partial = outcomeProbabilities(ctx, 'OFFER_PART_PAYMENT', 'WHATSAPP').payment
    expect(partial).toBeGreaterThan(nudge)
  })

  it('a discount beats a plain nudge for someone unwilling', () => {
    const ctx = context(latent({ ability: 0.8, willingness: 0.3, forgetfulness: 0.6 }))
    const nudge = outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').payment
    const discount = outcomeProbabilities(ctx, 'OFFER_DISCOUNT', 'WHATSAPP').payment
    expect(discount).toBeGreaterThan(nudge)
  })

  it('an instrument-repair request is the only thing that helps a dead instrument', () => {
    const ctx = context(latent({ mandateStatus: 'REVOKED' }))
    expect(outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').payment).toBe(0)
    expect(outcomeProbabilities(ctx, 'MANDATE_REPAIR', 'WHATSAPP').payment).toBeGreaterThan(0)
  })
})

describe('harm', () => {
  it('opt-out risk climbs past the annoyance threshold', () => {
    const state = latent({ annoyanceThreshold: 3 })
    const under = outcomeProbabilities(
      context(state, { touchCount: 1 }),
      'SEND_NUDGE',
      'SMS',
    ).optOut
    const over = outcomeProbabilities(context(state, { touchCount: 9 }), 'SEND_NUDGE', 'SMS').optOut

    expect(over).toBeGreaterThan(under)
    expect(under).toBeGreaterThan(0)
  })

  it('leaving someone alone never causes an opt-out', () => {
    expect(outcomeProbabilities(context(latent(), { touchCount: 20 }), 'WAIT').optOut).toBe(0)
  })

  it('goes silent once the customer has opted out', () => {
    const dynamic = createDynamicState()
    dynamic.optedOut = true
    const probabilities = outcomeProbabilities(
      context(latent(), {}, dynamic),
      'SEND_NUDGE',
      'WHATSAPP',
    )
    expect(probabilities).toEqual({ payment: 0, reply: 0, optOut: 0, cancellation: 0 })
  })

  it('goes silent once the customer has cancelled', () => {
    const dynamic = createDynamicState()
    dynamic.cancelled = true
    expect(outcomeProbabilities(context(latent(), {}, dynamic), 'RETRY_CHARGE').payment).toBe(0)
  })
})

describe('registerContact', () => {
  it('accumulates annoyance, and voice costs more than email', () => {
    const state = latent({ annoyanceThreshold: 4 })

    const viaEmail = createDynamicState()
    registerContact(viaEmail, state, 'EMAIL', MIDWEEK)

    const viaVoice = createDynamicState()
    registerContact(viaVoice, state, 'VOICE', MIDWEEK)

    expect(viaVoice.annoyanceAccrued).toBeGreaterThan(viaEmail.annoyanceAccrued)
    expect(viaEmail.lastContactAt).toBe(MIDWEEK)
  })
})

describe('sampleOutcome', () => {
  it('replays identically for the same seed', () => {
    const draw = (): string => {
      const rng = createRng(42)
      const ctx = context(latent())
      return Array.from({ length: 50 }, () =>
        JSON.stringify(sampleOutcome(rng, ctx, 'SEND_NUDGE', 'WHATSAPP').paid),
      ).join(',')
    }
    expect(draw()).toBe(draw())
  })

  it('converges on the stated probability', () => {
    const rng = createRng(11)
    const ctx = context(latent({ ability: 0.9, willingness: 0.9, forgetfulness: 0.9 }))
    const expected = outcomeProbabilities(ctx, 'SEND_NUDGE', 'WHATSAPP').payment

    let paid = 0
    for (let i = 0; i < 40_000; i++) {
      if (sampleOutcome(rng, ctx, 'SEND_NUDGE', 'WHATSAPP').paid) paid++
    }

    expect(paid / 40_000).toBeCloseTo(expected, 2)
  })

  it('never reports paying and opting out in the same tick', () => {
    const rng = createRng(3)
    const ctx = context(latent({ annoyanceThreshold: 1 }), { touchCount: 10 })
    for (let i = 0; i < 2_000; i++) {
      const outcome = sampleOutcome(rng, ctx, 'SEND_NUDGE', 'SMS')
      expect(outcome.paid && outcome.optedOut).toBe(false)
    }
  })
})
