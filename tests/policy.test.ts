import { describe, expect, it } from 'vitest'

import { loadAuthority, loadPolicy } from '../src/core/config-files'
import { fromIst, istDateKey } from '../src/core/calendar'
import { paise } from '../src/core/money'
import type { Channel } from '../src/domain/enums'
import type { PolicyContext } from '../src/policy/context'
import { PolicyEngine, PolicyIntegrityError } from '../src/policy/engine'

const authority = loadAuthority()
const policy = loadPolicy()
const HOLIDAYS = new Set([istDateKey(fromIst(2026, 9, 17))])
const engine = new PolicyEngine(policy, authority, HOLIDAYS)

const TUESDAY_2PM = fromIst(2026, 9, 15, 14)
const HOUR = 3_600_000
const DAY = 86_400_000

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const channel: Channel = overrides.channel ?? 'WHATSAPP'
  return {
    at: TUESDAY_2PM,
    action: 'SEND_NUDGE',
    channel,
    caseId: 'case_1',
    customerId: 'cust_1',
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
    consentByChannel: {
      SMS: { granted: true, purpose: 'payment_recovery', revokedAt: undefined },
      WHATSAPP: { granted: true, purpose: 'payment_recovery', revokedAt: undefined },
      EMAIL: { granted: true, purpose: 'payment_recovery', revokedAt: undefined },
      VOICE: { granted: true, purpose: 'payment_recovery', revokedAt: undefined },
      HUMAN: { granted: true, purpose: 'payment_recovery', revokedAt: undefined },
    },
    contactRoleAuthorised: true,
    touchesByChannel24h: {},
    touchesCase7d: 0,
    touchesCustomer7d: 0,
    lastTouchAt: undefined,
    lastInboundAt: TUESDAY_2PM - HOUR,
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
    content: undefined,
    modelPayload: undefined,
    ...overrides,
  }
}

function verdictOf(ruleId: string, ctx: PolicyContext): string {
  const evaluation = engine.evaluate(ctx).evaluations.find((e) => e.ruleId === ruleId)
  if (evaluation === undefined) throw new Error(`rule ${ruleId} was not evaluated`)
  return evaluation.verdict
}

const draft = (body: string, overrides: Partial<NonNullable<PolicyContext['content']>> = {}) => ({
  body,
  language: 'en' as const,
  amountPaise: paise(250_000),
  includesOffer: false,
  ...overrides,
})

const COVERED = new Set<string>()
function rule(id: string, name: string, body: () => void): void {
  COVERED.add(id)
  it(`${id}: ${name}`, body)
}

describe('policy engine integrity', () => {
  it('refuses a rule that has no predicate to enforce it', () => {
    expect(
      () =>
        new PolicyEngine(
          {
            policy_version: 'x',
            rules: [
              {
                id: 'GHOST_RULE',
                category: 'timing',
                applies_to: 'ALL',
                on_fail: 'DENY',
                params: {},
              },
            ],
          },
          authority,
          HOLIDAYS,
        ),
    ).toThrow(PolicyIntegrityError)
  })

  it('records an evaluation for every rule on every decision', () => {
    const result = engine.evaluate(context())
    expect(result.evaluations).toHaveLength(policy.rules.length)
  })

  it('fails closed when a rule throws', () => {
    const broken = new PolicyEngine(
      {
        policy_version: 'x',
        rules: policy.rules.map((r) =>
          r.id === 'QUIET_HOURS' ? { ...r, params: { start_hour: 'nine', end_hour: 20 } } : r,
        ),
      },
      authority,
      HOLIDAYS,
    )
    const evaluation = broken
      .evaluate(context())
      .evaluations.find((e) => e.ruleId === 'QUIET_HOURS')
    expect(evaluation?.verdict).toBe('DEFER')
    expect(evaluation?.detail).toMatch(/threw and is treated as a denial/)
  })
})

describe('timing rules', () => {
  rule('QUIET_HOURS', 'defers a 23:00 nudge to 09:00 rather than denying it', () => {
    const late = context({ at: fromIst(2026, 9, 15, 23) })
    const result = engine.evaluate(late)
    const evaluation = result.evaluations.find((e) => e.ruleId === 'QUIET_HOURS')

    expect(evaluation?.verdict).toBe('DEFER')
    expect(evaluation?.deferUntil).toBe(fromIst(2026, 9, 16, 9))
    expect(verdictOf('QUIET_HOURS', context())).toBe('ALLOW')
  })

  rule('GOOD_PAYER_GRACE', 'gives a reliable payer a few days before chasing them', () => {
    const loyal = context({
      priorCasesResolved: 8,
      priorCasesRecovered: 8,
      caseAgeDays: 1,
    })
    const evaluation = engine
      .evaluate(loyal)
      .evaluations.find((e) => e.ruleId === 'GOOD_PAYER_GRACE')

    expect(evaluation?.verdict).toBe('DEFER')
    expect(evaluation?.detail).toMatch(/8 of 8 previous bills settled/)
  })

  rule('GOOD_PAYER_GRACE', 'chases a customer with no track record immediately', () => {
    expect(
      verdictOf('GOOD_PAYER_GRACE', context({ priorCasesResolved: 0, priorCasesRecovered: 0 })),
    ).toBe('ALLOW')
  })

  rule('GOOD_PAYER_GRACE', 'does not shield a customer who usually does not pay', () => {
    expect(
      verdictOf(
        'GOOD_PAYER_GRACE',
        context({ priorCasesResolved: 10, priorCasesRecovered: 2, caseAgeDays: 1 }),
      ),
    ).toBe('ALLOW')
  })

  rule('GOOD_PAYER_GRACE', 'stops shielding once the grace period has passed', () => {
    expect(
      verdictOf(
        'GOOD_PAYER_GRACE',
        context({ priorCasesResolved: 8, priorCasesRecovered: 8, caseAgeDays: 9 }),
      ),
    ).toBe('ALLOW')
  })

  rule('RECOVERY_CALL_HOURS', 'holds human contact to a stricter window than messaging', () => {
    const evening = context({
      at: fromIst(2026, 9, 15, 19, 30),
      action: 'ESCALATE_HUMAN',
      channel: 'HUMAN',
    })
    expect(verdictOf('RECOVERY_CALL_HOURS', evening)).toBe('DEFER')
    expect(
      verdictOf('RECOVERY_CALL_HOURS', context({ action: 'ESCALATE_HUMAN', channel: 'HUMAN' })),
    ).toBe('ALLOW')
  })

  rule('NO_HOLIDAY_DUNNING', 'defers dunning during a festival', () => {
    expect(verdictOf('NO_HOLIDAY_DUNNING', context({ isFestival: true }))).toBe('DEFER')
    expect(verdictOf('NO_HOLIDAY_DUNNING', context())).toBe('ALLOW')
  })

  rule('BANK_HOLIDAY_MANDATE', 'defers a mandate debit to the next banking day', () => {
    const holiday = context({
      at: fromIst(2026, 9, 17, 11),
      action: 'RETRY_CHARGE',
      channel: undefined,
    })
    const evaluation = engine
      .evaluate(holiday)
      .evaluations.find((e) => e.ruleId === 'BANK_HOLIDAY_MANDATE')
    expect(evaluation?.verdict).toBe('DEFER')
    expect(istDateKey(evaluation?.deferUntil ?? 0)).toBe('2026-09-18')
  })
})

describe('consent rules', () => {
  rule('CONSENT_REQUIRED', 'denies a send on a channel with no granted consent', () => {
    const withheld = context({
      consentByChannel: {
        WHATSAPP: { granted: false, purpose: 'payment_recovery', revokedAt: undefined },
      },
    })
    expect(verdictOf('CONSENT_REQUIRED', withheld)).toBe('DENY')
    expect(verdictOf('CONSENT_REQUIRED', context())).toBe('ALLOW')
  })

  rule('OPT_OUT_ABSOLUTE', 'denies every contact after a global opt-out', () => {
    expect(verdictOf('OPT_OUT_ABSOLUTE', context({ optedOutGlobal: true }))).toBe('DENY')
  })

  rule('DND_SCRUB', 'blocks SMS to a DND number but leaves WhatsApp alone', () => {
    expect(verdictOf('DND_SCRUB', context({ dnd: true, channel: 'SMS' }))).toBe('DENY')
    expect(verdictOf('DND_SCRUB', context({ dnd: true, channel: 'WHATSAPP' }))).toBe('ALLOW')
  })

  rule('PROMO_RECLASSIFY', 'treats a reminder carrying a discount as promotional', () => {
    const early = context({
      at: fromIst(2026, 9, 15, 9, 30),
      action: 'OFFER_DISCOUNT',
      content: draft('here is 5% off', { includesOffer: true }),
    })
    expect(verdictOf('PROMO_RECLASSIFY', early)).toBe('DEFER')

    const plain = context({
      at: fromIst(2026, 9, 15, 9, 30),
      action: 'OFFER_DISCOUNT',
      content: draft('a reminder'),
    })
    expect(verdictOf('PROMO_RECLASSIFY', plain)).toBe('ALLOW')
  })

  rule('WA_SESSION_WINDOW', 'requires an approved template outside the 24h session', () => {
    const stale = context({ channel: 'WHATSAPP', lastInboundAt: TUESDAY_2PM - 30 * HOUR })
    expect(verdictOf('WA_SESSION_WINDOW', stale)).toBe('MODIFY')
    expect(verdictOf('WA_SESSION_WINDOW', context())).toBe('ALLOW')
  })
})

describe('frequency rules', () => {
  rule('FREQ_PER_CHANNEL_DAY', 'allows at most one send per channel per day', () => {
    expect(
      verdictOf('FREQ_PER_CHANNEL_DAY', context({ touchesByChannel24h: { WHATSAPP: 1 } })),
    ).toBe('DEFER')
    expect(verdictOf('FREQ_PER_CHANNEL_DAY', context({ touchesByChannel24h: { SMS: 1 } }))).toBe(
      'ALLOW',
    )
  })

  rule('FREQ_PER_CASE_WEEK', 'caps touches on one case per week', () => {
    expect(verdictOf('FREQ_PER_CASE_WEEK', context({ touchesCase7d: 3 }))).toBe('DEFER')
    expect(verdictOf('FREQ_PER_CASE_WEEK', context({ touchesCase7d: 2 }))).toBe('ALLOW')
  })

  rule('FREQ_GLOBAL_CUSTOMER_WEEK', 'caps touches across every case for one customer', () => {
    expect(verdictOf('FREQ_GLOBAL_CUSTOMER_WEEK', context({ touchesCustomer7d: 4 }))).toBe('DEFER')
    expect(verdictOf('FREQ_GLOBAL_CUSTOMER_WEEK', context({ touchesCustomer7d: 3 }))).toBe('ALLOW')
  })

  rule('MIN_GAP_BETWEEN_TOUCHES', 'enforces a day between touches', () => {
    expect(
      verdictOf('MIN_GAP_BETWEEN_TOUCHES', context({ lastTouchAt: TUESDAY_2PM - 2 * HOUR })),
    ).toBe('DEFER')
    expect(
      verdictOf('MIN_GAP_BETWEEN_TOUCHES', context({ lastTouchAt: TUESDAY_2PM - 25 * HOUR })),
    ).toBe('ALLOW')
  })
})

describe('escalation rules', () => {
  rule('ESCALATION_ORDER', 'refuses to skip a rung', () => {
    const leap = context({ action: 'ESCALATE_HUMAN', channel: 'HUMAN', rungReached: 0 })
    expect(verdictOf('ESCALATION_ORDER', leap)).toBe('DENY')

    const stepwise = context({ action: 'ESCALATE_CONTACT', rungReached: 1 })
    expect(verdictOf('ESCALATION_ORDER', stepwise)).toBe('ALLOW')
  })

  rule('ESCALATION_COOLDOWN', 'requires dwell time at the current rung before escalating', () => {
    const hasty = context({
      action: 'ESCALATE_CONTACT',
      rungReached: 1,
      lastRungChangeAt: TUESDAY_2PM - 2 * HOUR,
    })
    expect(verdictOf('ESCALATION_COOLDOWN', hasty)).toBe('DEFER')

    const patient = context({
      action: 'ESCALATE_CONTACT',
      rungReached: 1,
      lastRungChangeAt: TUESDAY_2PM - 5 * DAY,
    })
    expect(verdictOf('ESCALATION_COOLDOWN', patient)).toBe('ALLOW')
  })

  rule('NO_ESCALATION_DURING_PTP', 'holds off while a promise is live', () => {
    expect(verdictOf('NO_ESCALATION_DURING_PTP', context({ hasActivePromise: true }))).toBe('DEFER')
  })

  rule('NO_ESCALATION_DURING_DISPUTE', 'denies contact while a dispute is open', () => {
    expect(verdictOf('NO_ESCALATION_DURING_DISPUTE', context({ disputeOpen: true }))).toBe('DENY')
  })

  rule('THIRD_PARTY_DISCLOSURE', 'denies contact to an unauthorised party', () => {
    expect(verdictOf('THIRD_PARTY_DISCLOSURE', context({ contactRoleAuthorised: false }))).toBe(
      'DENY',
    )
  })
})

describe('content rules', () => {
  rule('NO_THREATS', 'denies threatening copy', () => {
    expect(
      verdictOf(
        'NO_THREATS',
        context({ content: draft('pay or we will send someone to your home') }),
      ),
    ).toBe('DENY')
    expect(
      verdictOf('NO_THREATS', context({ content: draft('your payment did not go through') })),
    ).toBe('ALLOW')
  })

  rule(
    'NO_LEGAL_IMPERSONATION',
    'denies claims of legal authority without an approved notice',
    () => {
      const bluff = context({ content: draft('this is a legal notice') })
      expect(verdictOf('NO_LEGAL_IMPERSONATION', bluff)).toBe('DENY')
    },
  )

  rule('NO_DARK_PATTERNS', 'denies manufactured urgency we cannot justify', () => {
    expect(verdictOf('NO_DARK_PATTERNS', context({ content: draft('last chance to pay') }))).toBe(
      'DENY',
    )
    expect(verdictOf('NO_DARK_PATTERNS', context({ content: draft('your payment is due') }))).toBe(
      'ALLOW',
    )
  })

  rule('NO_SHAMING', 'denies copy that threatens to tell an employer', () => {
    expect(
      verdictOf('NO_SHAMING', context({ content: draft('we will inform your employer') })),
    ).toBe('DENY')
  })

  rule('LANGUAGE_MATCH', 'denies copy in a language the customer did not choose', () => {
    const mismatch = context({
      preferredLanguage: 'hinglish',
      content: draft('hello', { language: 'en' }),
    })
    expect(verdictOf('LANGUAGE_MATCH', mismatch)).toBe('DENY')
  })

  rule(
    'AMOUNT_ACCURACY',
    'denies a message quoting anything but the current ledger balance',
    () => {
      const stale = context({
        outstandingPaise: paise(150_000),
        content: draft('you owe 2500', { amountPaise: paise(250_000) }),
      })
      expect(verdictOf('AMOUNT_ACCURACY', stale)).toBe('DENY')

      const accurate = context({
        outstandingPaise: paise(150_000),
        content: draft('you owe 1500', { amountPaise: paise(150_000) }),
      })
      expect(verdictOf('AMOUNT_ACCURACY', accurate)).toBe('ALLOW')
    },
  )
})

describe('data protection rules', () => {
  rule('PII_MINIMISATION', 'denies a model payload carrying a raw phone number', () => {
    expect(verdictOf('PII_MINIMISATION', context({ modelPayload: 'call 9876543210' }))).toBe('DENY')
    expect(verdictOf('PII_MINIMISATION', context({ modelPayload: 'call {{PHONE_1}}' }))).toBe(
      'ALLOW',
    )
  })

  rule('PURPOSE_LIMITATION', 'denies use of consent captured for another purpose', () => {
    const marketing = context({
      consentByChannel: { WHATSAPP: { granted: true, purpose: 'marketing', revokedAt: undefined } },
    })
    expect(verdictOf('PURPOSE_LIMITATION', marketing)).toBe('DENY')
  })

  rule('ERASURE_HONOURED', 'denies contact after an erasure request', () => {
    expect(verdictOf('ERASURE_HONOURED', context({ erasureRequestedAt: TUESDAY_2PM - DAY }))).toBe(
      'DENY',
    )
  })
})

describe('money safety rules', () => {
  rule('PRE_DEBIT_NOTICE', 'defers a mandate debit until 24h after the notice', () => {
    const noNotice = context({
      action: 'RETRY_CHARGE',
      channel: undefined,
      instrumentMethod: 'emandate',
    })
    expect(verdictOf('PRE_DEBIT_NOTICE', noNotice)).toBe('DEFER')

    const tooSoon = context({
      action: 'RETRY_CHARGE',
      channel: undefined,
      instrumentMethod: 'emandate',
      preDebitNoticeSentAt: TUESDAY_2PM - 2 * HOUR,
    })
    expect(verdictOf('PRE_DEBIT_NOTICE', tooSoon)).toBe('DEFER')

    const noticed = context({
      action: 'RETRY_CHARGE',
      channel: undefined,
      instrumentMethod: 'emandate',
      preDebitNoticeSentAt: TUESDAY_2PM - 30 * HOUR,
    })
    expect(verdictOf('PRE_DEBIT_NOTICE', noticed)).toBe('ALLOW')

    const cardRetry = context({
      action: 'RETRY_CHARGE',
      channel: undefined,
      instrumentMethod: 'card',
    })
    expect(verdictOf('PRE_DEBIT_NOTICE', cardRetry)).toBe('ALLOW')
  })

  rule('MANDATE_CAP', 'asks for a split rather than breaching the mandate cap', () => {
    const over = context({
      action: 'RETRY_CHARGE',
      channel: undefined,
      outstandingPaise: paise(500_000),
      mandateCapPaise: paise(300_000),
    })
    expect(verdictOf('MANDATE_CAP', over)).toBe('MODIFY')
  })

  rule('NETWORK_ATTEMPT_CAP', 'denies a retry that would look like card testing', () => {
    const hammering = context({ action: 'RETRY_CHARGE', channel: undefined, cardAttempts30d: 12 })
    expect(verdictOf('NETWORK_ATTEMPT_CAP', hammering)).toBe('DENY')
  })

  rule('NO_RETRY_INTO_DOWNTIME', 'defers a charge while the route is paused', () => {
    const paused = context({ action: 'RETRY_CHARGE', channel: undefined, cohortPaused: true })
    expect(verdictOf('NO_RETRY_INTO_DOWNTIME', paused)).toBe('DEFER')
  })

  rule('DISCOUNT_WITHIN_AUTHORITY', 'denies a discount beyond delegated authority', () => {
    const generous = context({ action: 'OFFER_DISCOUNT', discountPct: 25 })
    expect(verdictOf('DISCOUNT_WITHIN_AUTHORITY', generous)).toBe('DENY')

    const modest = context({ action: 'OFFER_DISCOUNT', discountPct: 8 })
    expect(verdictOf('DISCOUNT_WITHIN_AUTHORITY', modest)).toBe('ALLOW')
  })

  rule('EXTENSION_WITHIN_AUTHORITY', 'denies an extension beyond the cap', () => {
    expect(
      verdictOf(
        'EXTENSION_WITHIN_AUTHORITY',
        context({ action: 'GRANT_EXTENSION', extensionDays: 45 }),
      ),
    ).toBe('DENY')
    expect(
      verdictOf(
        'EXTENSION_WITHIN_AUTHORITY',
        context({ action: 'GRANT_EXTENSION', extensionDays: 10 }),
      ),
    ).toBe('ALLOW')
  })

  rule('HUMAN_APPROVAL_ABOVE_CEILING', 'denies a large-value action with no human approval', () => {
    const large = context({ outstandingPaise: paise(9_000_000) })
    expect(verdictOf('HUMAN_APPROVAL_ABOVE_CEILING', large)).toBe('DENY')
    expect(
      verdictOf('HUMAN_APPROVAL_ABOVE_CEILING', context({ ...large, humanApproved: true })),
    ).toBe('ALLOW')
  })
})

describe('rule coverage', () => {
  it('has a test for every rule in the policy file', () => {
    const untested = engine.ruleIds().filter((id) => !COVERED.has(id))
    expect(untested).toEqual([])
  })
})

describe('aggregation', () => {
  it('lets a denial outrank a deferral', () => {
    const result = engine.evaluate(context({ at: fromIst(2026, 9, 15, 23), optedOutGlobal: true }))
    expect(result.verdict).toBe('DENY')
    expect(result.deferUntil).toBeUndefined()
  })

  it('takes the latest deferral when several rules defer', () => {
    const result = engine.evaluate(context({ at: fromIst(2026, 9, 15, 23), touchesCase7d: 3 }))
    expect(result.verdict).toBe('DEFER')
    expect(result.deferUntil).toBe(
      Math.max(fromIst(2026, 9, 16, 9), fromIst(2026, 9, 15, 23) + DAY),
    )
  })

  it('allows an ordinary send', () => {
    expect(engine.evaluate(context()).verdict).toBe('ALLOW')
  })
})
