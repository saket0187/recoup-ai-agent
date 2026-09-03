import { describe, expect, it } from 'vitest'

import { loadAuthority, loadCosts, loadPolicy } from '../src/core/config-files'
import { fromIst } from '../src/core/calendar'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import {
  ThompsonBandit,
  armKeyOf,
  dayBucketOf,
  hourSlotOf,
  type ArmKey,
} from '../src/decision/bandit'
import { controlAction } from '../src/decision/control-arm'
import {
  ALL_FEATURES,
  DecisionEngine,
  type DecisionRequest,
  type EngineFeatures,
} from '../src/decision/engine'
import { costOf, valueOf } from '../src/decision/economics'
import { candidatesFor } from '../src/decision/playbook'
import type { ActionType, Channel, FailureClass } from '../src/domain/enums'
import type { PolicyContext } from '../src/policy/context'
import { PolicyEngine } from '../src/policy/engine'
import type { StopContext } from '../src/policy/stop-gate'

const authority = loadAuthority()
const costs = loadCosts()
const policy = loadPolicy()
const NOW = fromIst(2026, 9, 15, 14)
const HOUR = 3_600_000

describe('economics', () => {
  it('grows the annoyance cost with each touch', () => {
    const first = costOf('SEND_NUDGE', 'WHATSAPP', 0, costs)
    const fifth = costOf('SEND_NUDGE', 'WHATSAPP', 4, costs)
    expect(fifth.annoyancePaise).toBeGreaterThan(first.annoyancePaise * 3)
  })

  it('prices voice above email', () => {
    expect(costOf('SEND_NUDGE', 'VOICE', 0, costs).totalPaise).toBeGreaterThan(
      costOf('SEND_NUDGE', 'EMAIL', 0, costs).totalPaise,
    )
  })

  it('values an action on uplift, not on raw success probability', () => {
    const valued = valueOf(
      {
        action: 'SEND_NUDGE',
        channel: 'EMAIL',
        uplift: 0.1,
        outstandingPaise: paise(1_000_000),
        touchCount: 0,
      },
      costs,
    )
    expect(valued.grossPaise).toBe(Math.round(0.1 * 1_000_000 * 0.3))
    expect(valued.evPaise).toBe(valued.grossPaise - valued.cost.totalPaise)
  })

  it('is negative when the uplift cannot pay for the channel', () => {
    const valued = valueOf(
      {
        action: 'SEND_NUDGE',
        channel: 'VOICE',
        uplift: 0.0001,
        outstandingPaise: paise(50_000),
        touchCount: 3,
      },
      costs,
    )
    expect(valued.evPaise).toBeLessThan(0)
  })

  it('rejects a non-finite uplift rather than producing a silent NaN', () => {
    expect(() =>
      valueOf(
        {
          action: 'SEND_NUDGE',
          channel: 'SMS',
          uplift: Number.NaN,
          outstandingPaise: paise(1),
          touchCount: 0,
        },
        costs,
      ),
    ).toThrow()
  })
})

describe('ThompsonBandit', () => {
  const key = (action: ActionType): ArmKey => ({
    action,
    method: 'upi',
    issuer: 'HDFC',
    dayBucket: dayBucketOf(NOW),
    hourSlot: hourSlotOf(NOW),
    failureClass: 'FUNDS_TIMING',
    attemptBucket: 'first',
  })

  it('starts from a documented prior rather than zero knowledge', () => {
    const bandit = new ThompsonBandit(createRng(1))
    expect(bandit.mean(key('RETRY_CHARGE'))).toBeCloseTo(0.2, 5)
    expect(bandit.observations(key('RETRY_CHARGE'))).toBe(0)
  })

  it('moves the posterior towards observed reality', () => {
    const bandit = new ThompsonBandit(createRng(1))
    const arm = key('RETRY_CHARGE')
    for (let i = 0; i < 200; i++) bandit.update(arm, i % 4 === 0)
    expect(bandit.mean(arm)).toBeCloseTo(0.25, 1)
    expect(bandit.observations(arm)).toBe(200)
  })

  it('keeps the first retry and the fourth on separate arms, so decay is learnable', () => {
    const bandit = new ThompsonBandit(createRng(1))
    const first: ArmKey = { ...key('RETRY_CHARGE'), attemptBucket: 'first' }
    const later: ArmKey = { ...key('RETRY_CHARGE'), attemptBucket: 'later' }

    for (let i = 0; i < 100; i++) bandit.update(first, true)
    for (let i = 0; i < 100; i++) bandit.update(later, false)

    expect(bandit.mean(first)).toBeGreaterThan(0.9)
    expect(bandit.mean(later)).toBeLessThan(0.1)
  })

  it('keeps arms separate by time bucket, which is what makes timing learnable', () => {
    const bandit = new ThompsonBandit(createRng(1))
    const salary: ArmKey = { ...key('RETRY_CHARGE'), dayBucket: 'salary' }
    const monthEnd: ArmKey = { ...key('RETRY_CHARGE'), dayBucket: 'month_end' }

    for (let i = 0; i < 100; i++) bandit.update(salary, true)
    for (let i = 0; i < 100; i++) bandit.update(monthEnd, false)

    expect(bandit.mean(salary)).toBeGreaterThan(0.9)
    expect(bandit.mean(monthEnd)).toBeLessThan(0.1)
  })

  it('samples deterministically for a seed', () => {
    const draw = (): number[] => {
      const bandit = new ThompsonBandit(createRng(7))
      return Array.from({ length: 20 }, () => bandit.sample(key('RETRY_CHARGE')))
    }
    expect(draw()).toEqual(draw())
  })

  it('buckets salary days, month end and mid-month apart', () => {
    expect(dayBucketOf(fromIst(2026, 9, 2, 12))).toBe('salary')
    expect(dayBucketOf(fromIst(2026, 9, 28, 12))).toBe('month_end')
    expect(dayBucketOf(fromIst(2026, 9, 15, 12))).toBe('mid_month')
  })

  it('builds a stable arm key', () => {
    expect(armKeyOf(key('RETRY_CHARGE'))).toBe(
      'RETRY_CHARGE|upi|HDFC|mid_month|3|FUNDS_TIMING|first',
    )
  })
})

describe('playbook', () => {
  const inputs = (failureClass: FailureClass, overrides = {}) => ({
    failureClass,
    attemptCount: 0,
    touchCount: 0,
    cohortPaused: false,
    mandateCapExceeded: false,
    preferredChannel: 'WHATSAPP' as Channel,
    ...overrides,
  })

  it('escalates to a call only after written reminders have not landed', () => {
    const early = candidatesFor(inputs('FUNDS_TIMING', { touchCount: 1 })).map((c) => c.action)
    const late = candidatesFor(inputs('FUNDS_TIMING', { touchCount: 4 }))

    expect(early).not.toContain('ESCALATE_CONTACT')
    expect(late.map((c) => c.action)).toContain('ESCALATE_CONTACT')
    expect(late.find((c) => c.action === 'ESCALATE_CONTACT')?.channel).toBe('VOICE')
  })

  it('never calls a customer about a failure that is our own fault', () => {
    for (const failureClass of ['TRANSIENT_INFRA', 'MERCHANT_DEFECT'] as FailureClass[]) {
      const actions = candidatesFor(inputs(failureClass, { touchCount: 6 })).map((c) => c.action)
      expect(actions).not.toContain('ESCALATE_CONTACT')
    }
  })

  it('does not escalate into a paused route', () => {
    const actions = candidatesFor(
      inputs('FUNDS_TIMING', { touchCount: 6, cohortPaused: true }),
    ).map((c) => c.action)
    expect(actions).not.toContain('ESCALATE_CONTACT')
  })

  it('always offers doing nothing', () => {
    for (const failureClass of ['FUNDS_TIMING', 'AUTH_DROPOFF', 'RISK_DECLINE'] as FailureClass[]) {
      expect(candidatesFor(inputs(failureClass)).map((c) => c.action)).toContain('WAIT')
    }
  })

  it('never proposes contacting a customer about our own defect', () => {
    const actions = candidatesFor(inputs('MERCHANT_DEFECT'))
    expect(actions.every((candidate) => candidate.channel === undefined)).toBe(true)
    expect(actions.map((c) => c.action)).toContain('RAISE_ENG_TICKET')
  })

  it('marks operational actions so they never compete on recovery value', () => {
    const ticket = candidatesFor(inputs('MERCHANT_DEFECT')).find(
      (c) => c.action === 'RAISE_ENG_TICKET',
    )
    const pause = candidatesFor(inputs('TRANSIENT_INFRA')).find((c) => c.action === 'PAUSE_COHORT')
    expect(ticket?.operational).toBe(true)
    expect(pause?.operational).toBe(true)
  })

  it('does not offer write-off as a recovery candidate; the stop gate owns that', () => {
    for (const failureClass of ['FUNDS_TIMING', 'AUTH_DROPOFF', 'AMBIGUOUS'] as FailureClass[]) {
      expect(candidatesFor(inputs(failureClass)).map((c) => c.action)).not.toContain('WRITE_OFF')
    }
  })

  it('never proposes contacting a customer during an infrastructure failure', () => {
    const actions = candidatesFor(inputs('TRANSIENT_INFRA'))
    expect(actions.every((candidate) => candidate.channel === undefined)).toBe(true)
  })

  it('never proposes retrying a dead instrument', () => {
    const actions = candidatesFor(inputs('INSTRUMENT_INVALID')).map((c) => c.action)
    expect(actions).not.toContain('RETRY_CHARGE')
    expect(actions).toContain('REQUEST_INSTRUMENT_UPDATE')
  })

  it('does not retry into a paused route', () => {
    expect(
      candidatesFor(inputs('TRANSIENT_INFRA', { cohortPaused: true })).map((c) => c.action),
    ).not.toContain('RETRY_CHARGE')
  })

  it('offers a split only when our own mandate cap is the problem', () => {
    expect(candidatesFor(inputs('MANDATE_BROKEN')).map((c) => c.action)).not.toContain(
      'SPLIT_RETRY',
    )
    expect(
      candidatesFor(inputs('MANDATE_BROKEN', { mandateCapExceeded: true })).map((c) => c.action),
    ).toContain('SPLIT_RETRY')
  })

  it('allows at most one alternative route on a risk decline', () => {
    expect(candidatesFor(inputs('RISK_DECLINE')).map((c) => c.action)).toContain(
      'RETRY_CHARGE_ALT_ROUTE',
    )
    expect(
      candidatesFor(inputs('RISK_DECLINE', { attemptCount: 1 })).map((c) => c.action),
    ).not.toContain('RETRY_CHARGE_ALT_ROUTE')
  })

  it('opens offers only after repeated funds failures', () => {
    expect(candidatesFor(inputs('FUNDS_TIMING')).map((c) => c.action)).not.toContain(
      'OFFER_PART_PAYMENT',
    )
    expect(
      candidatesFor(inputs('FUNDS_TIMING', { attemptCount: 3 })).map((c) => c.action),
    ).toContain('OFFER_PART_PAYMENT')
  })

  it('caps auth-dropoff nudges at two', () => {
    expect(candidatesFor(inputs('AUTH_DROPOFF')).map((c) => c.action)).toContain('SEND_NUDGE')
    expect(
      candidatesFor(inputs('AUTH_DROPOFF', { touchCount: 2 })).map((c) => c.action),
    ).not.toContain('SEND_NUDGE')
  })
})

describe('control arm', () => {
  it('retries on a fixed T+24/48/72h schedule', () => {
    const base = { firstSeenAt: NOW, touchCount: 0, lastAttemptAt: undefined }
    expect(controlAction({ ...base, at: NOW + 25 * HOUR, attemptCount: 0 }).action).toBe(
      'RETRY_CHARGE',
    )
    expect(controlAction({ ...base, at: NOW + 49 * HOUR, attemptCount: 1 }).action).toBe(
      'RETRY_CHARGE',
    )
    expect(controlAction({ ...base, at: NOW + 73 * HOUR, attemptCount: 2 }).action).toBe(
      'RETRY_CHARGE',
    )
  })

  it('waits before the first scheduled retry', () => {
    expect(
      controlAction({
        at: NOW + HOUR,
        firstSeenAt: NOW,
        attemptCount: 0,
        touchCount: 0,
      }).action,
    ).toBe('WAIT')
  })

  it('sends one SMS after the first failure', () => {
    const choice = controlAction({
      at: NOW + 2 * HOUR,
      firstSeenAt: NOW,
      attemptCount: 1,
      touchCount: 0,
    })
    expect(choice.action).toBe('SEND_NUDGE')
    expect(choice.channel).toBe('SMS')
  })

  it('stops after its fixed schedule is exhausted', () => {
    expect(
      controlAction({
        at: NOW + 200 * HOUR,
        firstSeenAt: NOW,
        attemptCount: 3,
        touchCount: 2,
      }).action,
    ).toBe('WAIT')
  })
})

describe('DecisionEngine', () => {
  function build(seed = 42, features: EngineFeatures = ALL_FEATURES): DecisionEngine {
    const rng = createRng(seed)
    return new DecisionEngine({
      policy: new PolicyEngine(policy, authority, new Set()),
      authority,
      costs,
      bandit: new ThompsonBandit(rng.derive('bandit')),
      rng,
      features,
    })
  }

  function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
    const policyContext = (action: ActionType, channel: Channel | undefined): PolicyContext => ({
      at: NOW,
      action,
      channel,
      caseId: 'case_1',
      customerId: 'cust_1',
      outstandingPaise: overrides.outstandingPaise ?? paise(2_000_000),
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
      lastInboundAt: NOW - HOUR,
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
    })

    const stopContext = (
      action: ActionType,
      bestRemainingEvPaise: ReturnType<typeof paise>,
    ): StopContext => ({
      at: NOW,
      action,
      outstandingPaise: overrides.outstandingPaise ?? paise(2_000_000),
      originalAmountPaise: paise(2_000_000),
      disputeOpen: false,
      invoiceDisputed: false,
      optedOut: false,
      wrongPerson: false,
      deceased: false,
      distressSignalled: false,
      abuseSignalled: false,
      retriesExcludingInfra: 0,
      touchCount: 0,
      bestRemainingEvPaise,
      mandateDead: false,
      riskFlagged: false,
      cohortPaused: false,
      killSwitchEngaged: false,
      merchantPaused: false,
      hasActivePromise: false,
      promiseDueAt: undefined,
      caseAgeDays: 3,
      economicStopsApply: true,
    })

    return {
      at: NOW,
      caseId: 'case_1',
      arm: 'TREATMENT',
      failureClass: 'FUNDS_TIMING',
      outstandingPaise: paise(2_000_000),
      originalAmountPaise: paise(2_000_000),
      method: 'upi',
      issuer: 'HDFC',
      attemptCount: 0,
      touchCount: 0,
      cohortPaused: false,
      mandateCapExceeded: false,
      preferredChannel: 'WHATSAPP',
      firstSeenAt: NOW - 3 * 24 * HOUR,
      features: { failure_class: 'FUNDS_TIMING' },
      upliftFeatures: {
        outstandingPaise: paise(2_000_000),
        failureClass: 'FUNDS_TIMING' as const,
        portfolio: 'd2c_subscription' as const,
        method: 'upi' as const,
        attemptCount: 0,
        touchCount: 0,
        daysSinceDue: 0,
        at: NOW,
      },
      policyContextFor: policyContext,
      stopContextFor: stopContext,
      ...overrides,
    }
  }

  it('records every candidate it considered, not only the winner', () => {
    const outcome = build().decide(request())
    expect(outcome.candidates.length).toBeGreaterThan(2)
    expect(outcome.candidates.every((c) => Number.isFinite(c.evPaise))).toBe(true)
  })

  it('records a real propensity strictly between zero and one', () => {
    const outcome = build().decide(request())
    expect(outcome.propensity).toBeGreaterThan(0)
    expect(outcome.propensity).toBeLessThanOrEqual(1)
  })

  it('never reports a propensity of exactly zero, which would void off-policy evaluation', () => {
    for (let seed = 0; seed < 25; seed++) {
      expect(build(seed).decide(request()).propensity).toBeGreaterThan(0)
    }
  })

  it('gives the deterministic control arm a propensity of one', () => {
    const outcome = build().decide(request({ arm: 'CONTROL' }))
    expect(outcome.propensity).toBe(1)
  })

  it('records every stop condition on every decision', () => {
    expect(build().decide(request()).stopEvaluations).toHaveLength(18)
  })

  it('suppresses rather than executes when the stop gate stops', () => {
    const outcome = build().decide(
      request({
        stopContextFor: (action) => ({
          ...request().stopContextFor(action, paise(1)),
          optedOut: true,
        }),
      }),
    )
    expect(outcome.finalVerdict).toBe('SUPPRESS')
    expect(outcome.suppressReason).toBe('STOP_OPT_OUT')
  })

  it('falls back to the incumbent schedule when nothing clears its cost', () => {
    const outcome = build().decide(request({ outstandingPaise: paise(3_000) }))
    expect(outcome.chosenAction).toBe('RETRY_CHARGE')
  })

  it('falls back to waiting when nothing clears its cost and the incumbent is not due', () => {
    const outcome = build().decide(
      request({ outstandingPaise: paise(3_000), firstSeenAt: NOW - HOUR }),
    )
    expect(outcome.chosenAction).toBe('WAIT')
    expect(outcome.finalVerdict).toBe('SUPPRESS')
  })

  it('waits rather than deferring to the incumbent when the floor is disabled', () => {
    const engine = build(7, { ...ALL_FEATURES, incumbentFloor: false })
    const outcome = engine.decide(request({ outstandingPaise: paise(3_000) }))
    expect(outcome.chosenAction).toBe('WAIT')
  })

  it('still lets the stop gate halt an action taken from the incumbent floor', () => {
    const outcome = build().decide(
      request({
        outstandingPaise: paise(3_000),
        stopContextFor: (action) => ({
          ...request().stopContextFor(action, paise(1)),
          optedOut: true,
        }),
      }),
    )
    expect(outcome.finalVerdict).toBe('SUPPRESS')
    expect(outcome.suppressReason).toBe('STOP_OPT_OUT')
  })

  it('reports the operational action for a merchant defect without letting it win on value', () => {
    const outcome = build().decide(request({ failureClass: 'MERCHANT_DEFECT' }))
    expect(outcome.operationalActions).toContain('RAISE_ENG_TICKET')
    expect(outcome.chosenAction).not.toBe('RAISE_ENG_TICKET')
  })

  it('replays identically for the same seed', () => {
    const first = build(11).decide(request())
    const second = build(11).decide(request())
    expect(first.chosenAction).toBe(second.chosenAction)
    expect(first.propensity).toBe(second.propensity)
  })

  it('carries the policy and playbook versions for the audit record', () => {
    const outcome = build().decide(request())
    expect(outcome.policyVersion).toBe(policy.policy_version)
    expect(outcome.playbookVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}/)
  })

  it('treats MODIFY as admissible, since the modification is applied not the send blocked', () => {
    const base = request()
    const outcome = build().decide({
      ...base,
      policyContextFor: (action, channel) => ({
        ...base.policyContextFor(action, channel),
        lastInboundAt: undefined,
      }),
    })

    const whatsapp = outcome.candidates.filter((candidate) => candidate.channel === 'WHATSAPP')
    expect(whatsapp.length).toBeGreaterThan(0)
    expect(whatsapp.every((candidate) => candidate.admissible)).toBe(true)
  })

  it('explores across seeds rather than always picking one action', () => {
    const chosen = new Set(
      Array.from({ length: 30 }, (_, seed) => build(seed).decide(request()).chosenAction),
    )
    expect(chosen.size).toBeGreaterThan(1)
  })
})

describe('the control arm is a baseline, not an agent', () => {
  function requestFor(arm: 'TREATMENT' | 'CONTROL'): DecisionRequest {
    const policyContext = (action: ActionType, channel: Channel | undefined): PolicyContext => ({
      at: NOW,
      action,
      channel,
      caseId: 'case_1',
      customerId: 'cust_1',
      outstandingPaise: paise(2_000_000),
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
      lastInboundAt: NOW - HOUR,
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
    })

    return {
      at: NOW,
      caseId: 'case_1',
      arm,
      failureClass: 'FUNDS_TIMING',
      outstandingPaise: paise(2_000_000),
      originalAmountPaise: paise(2_000_000),
      method: 'upi',
      issuer: 'HDFC',
      attemptCount: 1,
      touchCount: 0,
      cohortPaused: false,
      mandateCapExceeded: false,
      preferredChannel: 'WHATSAPP',
      firstSeenAt: NOW - 3 * 24 * HOUR,
      features: { failure_class: 'FUNDS_TIMING' },
      upliftFeatures: {
        outstandingPaise: paise(2_000_000),
        failureClass: 'FUNDS_TIMING' as const,
        portfolio: 'd2c_subscription' as const,
        method: 'upi' as const,
        attemptCount: 0,
        touchCount: 0,
        daysSinceDue: 0,
        at: NOW,
      },
      policyContextFor: policyContext,
      stopContextFor: (action, bestRemainingEvPaise) => ({
        at: NOW,
        action,
        outstandingPaise: paise(2_000_000),
        originalAmountPaise: paise(2_000_000),
        disputeOpen: false,
        invoiceDisputed: false,
        optedOut: false,
        wrongPerson: false,
        deceased: false,
        distressSignalled: false,
        abuseSignalled: false,
        retriesExcludingInfra: 0,
        touchCount: 0,
        bestRemainingEvPaise,
        mandateDead: false,
        riskFlagged: false,
        cohortPaused: false,
        killSwitchEngaged: false,
        merchantPaused: false,
        hasActivePromise: false,
        promiseDueAt: undefined,
        caseAgeDays: 3,
        economicStopsApply: true,
      }),
    }
  }

  function controlEngine(costsOverride: typeof costs): DecisionEngine {
    const rng = createRng(42)
    return new DecisionEngine({
      policy: new PolicyEngine(policy, authority, new Set()),
      authority,
      costs: costsOverride,
      bandit: new ThompsonBandit(rng.derive('bandit')),
      rng,
    })
  }

  const expensive: typeof costs = {
    ...costs,
    channels: Object.fromEntries(
      Object.entries(costs.channels).map(([channel, entry]) => [
        channel,
        { ...entry, annoyance_paise: 50_000_000 },
      ]),
    ),
  }

  it('acts on its fixed schedule even when the cost model says the action is uneconomic', () => {
    const base = requestFor('CONTROL')
    const cheap = controlEngine(costs).decide(base)
    const dear = controlEngine(expensive).decide(base)

    expect(cheap.chosenAction).toBe(dear.chosenAction)
  })

  it('stops the treatment arm reaching for a channel once contact is priced out', () => {
    const base = requestFor('TREATMENT')
    const dear = controlEngine(expensive).decide(base)

    expect(dear.chosenChannel).toBeUndefined()
    expect(
      dear.candidates
        .filter((candidate) => candidate.channel !== undefined)
        .every((candidate) => candidate.evPaise < 0),
    ).toBe(true)
  })
})
