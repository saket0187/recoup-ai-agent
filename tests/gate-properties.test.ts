import fc from 'fast-check'
import { describe, it } from 'vitest'

import { fromIst, istDateKey, istHour } from '../src/core/calendar'
import { loadAuthority, loadPolicy } from '../src/core/config-files'
import { paise } from '../src/core/money'
import { ACTION_TYPES, CHANNELS, type Channel, type ActionType } from '../src/domain/enums'
import type { PolicyContext } from '../src/policy/context'
import { PolicyEngine } from '../src/policy/engine'
import { evaluateStopGate, type StopContext } from '../src/policy/stop-gate'

const authority = loadAuthority()
const policy = loadPolicy()
const HOLIDAY = istDateKey(fromIst(2026, 9, 17))
const engine = new PolicyEngine(policy, authority, new Set([HOLIDAY]))

const CONTACT_CHANNELS: readonly Channel[] = ['SMS', 'WHATSAPP', 'EMAIL', 'VOICE']
const MESSAGING_ACTIONS: readonly ActionType[] = [
  'SEND_NUDGE',
  'SEND_PAYMENT_LINK',
  'SEND_PRE_DEBIT_NOTICE',
  'OFFER_METHOD_SWITCH',
  'REQUEST_INSTRUMENT_UPDATE',
  'MANDATE_REPAIR',
]

const RUNS = 400

const consentAll = Object.fromEntries(
  CHANNELS.map((channel) => [
    channel,
    { granted: true, purpose: 'payment_recovery', revokedAt: undefined },
  ]),
) as PolicyContext['consentByChannel']

function baseContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    at: fromIst(2026, 9, 15, 14),
    action: 'SEND_NUDGE',
    channel: 'WHATSAPP',
    caseId: 'case_prop',
    customerId: 'cust_prop',
    outstandingPaise: paise(250_000),
    caseAgeDays: 3,
    disputeOpen: false,
    hasActivePromise: false,
    priorCasesResolved: 0,
    priorCasesRecovered: 0,
    optedOutGlobal: false,
    dnd: false,
    erasureRequestedAt: undefined,
    preferredLanguage: 'en',
    consentByChannel: consentAll,
    contactRoleAuthorised: true,
    touchesByChannel24h: {},
    touchesCase7d: 0,
    touchesCustomer7d: 0,
    lastTouchAt: undefined,
    lastInboundAt: fromIst(2026, 9, 15, 13),
    rungReached: 1,
    lastRungChangeAt: undefined,
    isFestival: false,
    cohortPaused: false,
    instrumentMethod: 'upi',
    mandateCapPaise: undefined,
    preDebitNoticeSentAt: undefined,
    cardAttempts30d: 0,
    discountPct: undefined,
    discountPaise: undefined,
    extensionDays: undefined,
    humanApproved: false,
    content: {
      body: 'Your payment of Rs 2,500.00 did not go through. You can retry any time.',
      language: 'en',
      amountPaise: paise(250_000),
      includesOffer: false,
    },
    modelPayload: undefined,
    ...overrides,
  }
}

const anyInstant = fc
  .record({
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ day, hour, minute }) => fromIst(2026, 9, day, hour, minute))

const anyMessaging = fc.constantFrom(...MESSAGING_ACTIONS)
const anyContactChannel = fc.constantFrom(...CONTACT_CHANNELS)

function allowed(context: PolicyContext): boolean {
  return engine
    .evaluate(context)
    .evaluations.every((e) => e.verdict !== 'DENY' && e.verdict !== 'DEFER')
}

describe('policy gate properties', () => {
  it('never allows an outbound message outside 09:00 to 20:00 IST, for any action or channel', () => {
    fc.assert(
      fc.property(anyInstant, anyMessaging, anyContactChannel, (at, action, channel) => {
        const hour = istHour(at)
        if (hour >= 9 && hour < 20) return true
        return !allowed(baseContext({ at, action, channel }))
      }),
      { numRuns: RUNS },
    )
  })

  it('never allows contact to someone who opted out, at any hour on any channel', () => {
    fc.assert(
      fc.property(anyInstant, anyMessaging, anyContactChannel, (at, action, channel) => {
        return !allowed(baseContext({ at, action, channel, optedOutGlobal: true }))
      }),
      { numRuns: RUNS },
    )
  })

  it('never allows contact without consent on the channel it would use', () => {
    fc.assert(
      fc.property(anyMessaging, anyContactChannel, (action, channel) => {
        const revoked = {
          ...consentAll,
          [channel]: { granted: false, purpose: 'payment_recovery', revokedAt: undefined },
        } as PolicyContext['consentByChannel']
        return !allowed(baseContext({ action, channel, consentByChannel: revoked }))
      }),
      { numRuns: RUNS },
    )
  })

  it('never allows an SMS or a call to a do-not-disturb registration', () => {
    fc.assert(
      fc.property(anyMessaging, fc.constantFrom<Channel>('SMS', 'VOICE'), (action, channel) => {
        return !allowed(baseContext({ action, channel, dnd: true }))
      }),
      { numRuns: RUNS },
    )
  })

  it('leaves WhatsApp and email to their own consent, which is what the registry covers', () => {
    fc.assert(
      fc.property(
        anyMessaging,
        fc.constantFrom<Channel>('WHATSAPP', 'EMAIL'),
        (action, channel) => {
          const withoutConsent = {
            ...consentAll,
            [channel]: { granted: false, purpose: 'payment_recovery', revokedAt: undefined },
          } as PolicyContext['consentByChannel']
          return !allowed(
            baseContext({ action, channel, dnd: true, consentByChannel: withoutConsent }),
          )
        },
      ),
      { numRuns: RUNS },
    )
  })

  it('returns the same verdicts for the same context every time', () => {
    fc.assert(
      fc.property(anyInstant, anyMessaging, anyContactChannel, (at, action, channel) => {
        const context = baseContext({ at, action, channel })
        const first = engine.evaluate(context).evaluations.map((e) => `${e.ruleId}:${e.verdict}`)
        const second = engine.evaluate(context).evaluations.map((e) => `${e.ruleId}:${e.verdict}`)
        return first.join('|') === second.join('|')
      }),
      { numRuns: RUNS },
    )
  })

  it('evaluates every configured rule on every action, so nothing is silently skipped', () => {
    const ruleIds = new Set(policy.rules.map((r) => r.id))
    fc.assert(
      fc.property(fc.constantFrom(...ACTION_TYPES), anyContactChannel, (action, channel) => {
        const evaluated = new Set(
          engine.evaluate(baseContext({ action, channel })).evaluations.map((e) => e.ruleId),
        )
        for (const id of evaluated) if (!ruleIds.has(id)) return false
        return evaluated.size > 0
      }),
      { numRuns: RUNS },
    )
  })
})

function stopContext(overrides: Partial<StopContext> = {}): StopContext {
  return {
    at: fromIst(2026, 9, 15, 14),
    action: 'SEND_NUDGE',
    outstandingPaise: paise(250_000),
    bestRemainingEvPaise: paise(10_000),
    attemptCount: 0,
    touchCount: 0,
    caseAgeDays: 3,
    optedOut: false,
    deceased: false,
    wrongPerson: false,
    vulnerable: false,
    abusive: false,
    riskFlagged: false,
    disputeOpen: false,
    invoiceDisputed: false,
    hasActivePromise: false,
    promiseDueAt: undefined,
    mandateDead: false,
    cohortPaused: false,
    killSwitchEngaged: false,
    merchantPaused: false,
    partiallyPaid: false,
    ...overrides,
  } as StopContext
}

describe('stop gate properties', () => {
  const anyAction = fc.constantFrom(...ACTION_TYPES)

  it('always stops once nothing is outstanding, whatever else is true', () => {
    fc.assert(
      fc.property(anyAction, fc.integer({ min: 0, max: 12 }), (action, touchCount) => {
        const result = evaluateStopGate(
          stopContext({ action, touchCount, outstandingPaise: paise(0) }),
          authority,
        )
        return result.verdict !== 'CONTINUE'
      }),
      { numRuns: RUNS },
    )
  })

  it('always halts every action while the kill switch is engaged', () => {
    fc.assert(
      fc.property(anyAction, (action) => {
        const result = evaluateStopGate(stopContext({ action, killSwitchEngaged: true }), authority)
        return result.verdict === 'STOP'
      }),
      { numRuns: RUNS },
    )
  })

  it('never continues for someone who opted out, deceased, or reported wrong person', () => {
    fc.assert(
      fc.property(
        anyAction,
        fc.constantFrom<'optedOut' | 'deceased' | 'wrongPerson'>(
          'optedOut',
          'deceased',
          'wrongPerson',
        ),
        (action, flag) => {
          const result = evaluateStopGate(stopContext({ action, [flag]: true }), authority)
          return result.verdict !== 'CONTINUE'
        },
      ),
      { numRuns: RUNS },
    )
  })

  it('evaluates all 18 conditions on every action, whatever the context', () => {
    fc.assert(
      fc.property(anyAction, fc.integer({ min: 0, max: 20 }), (action, touchCount) => {
        const result = evaluateStopGate(stopContext({ action, touchCount }), authority)
        return result.evaluations.length === 18
      }),
      { numRuns: RUNS },
    )
  })

  it('reaches the same verdict for the same context every time', () => {
    fc.assert(
      fc.property(anyAction, fc.integer({ min: 0, max: 20 }), (action, touchCount) => {
        const context = stopContext({ action, touchCount })
        const a = evaluateStopGate(context, authority)
        const b = evaluateStopGate(context, authority)
        return a.verdict === b.verdict && a.reason === b.reason
      }),
      { numRuns: RUNS },
    )
  })
})
