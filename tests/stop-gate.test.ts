import { describe, expect, it } from 'vitest'

import { loadAuthority } from '../src/core/config-files'
import { fromIst } from '../src/core/calendar'
import { paise } from '../src/core/money'
import { STOP_CONDITION_IDS, evaluateStopGate, type StopContext } from '../src/policy/stop-gate'

const authority = loadAuthority()
const NOW = fromIst(2026, 9, 15, 14)
const HOUR = 3_600_000

function context(overrides: Partial<StopContext> = {}): StopContext {
  return {
    at: NOW,
    action: 'SEND_NUDGE',
    outstandingPaise: paise(250_000),
    originalAmountPaise: paise(250_000),
    disputeOpen: false,
    invoiceDisputed: false,
    optedOut: false,
    wrongPerson: false,
    deceased: false,
    distressSignalled: false,
    abuseSignalled: false,
    retriesExcludingInfra: 0,
    touchCount: 0,
    bestRemainingEvPaise: paise(5_000),
    mandateDead: false,
    riskFlagged: false,
    cohortPaused: false,
    killSwitchEngaged: false,
    merchantPaused: false,
    hasActivePromise: false,
    promiseDueAt: undefined,
    economicStopsApply: true,
    caseAgeDays: 3,
    ...overrides,
  }
}

const run = (overrides: Partial<StopContext> = {}) =>
  evaluateStopGate(context(overrides), authority)

const COVERED = new Set<string>()
function condition(id: string, name: string, body: () => void): void {
  COVERED.add(id)
  it(`${id}: ${name}`, body)
}

describe('stop conditions', () => {
  condition('STOP_PAID', 'stops once the ledger clears', () => {
    const result = run({ outstandingPaise: paise(0) })
    expect(result.verdict).toBe('STOP')
    expect(result.reason).toBe('STOP_PAID')
  })

  condition('STOP_PARTIAL', 'does not stop on a partial payment but flags a re-anchor', () => {
    const result = run({ outstandingPaise: paise(100_000), originalAmountPaise: paise(250_000) })
    expect(result.verdict).toBe('CONTINUE')
    expect(result.reAnchorAmount).toBe(true)
  })

  condition('STOP_DISPUTE', 'freezes on a chargeback', () => {
    expect(run({ disputeOpen: true }).reason).toBe('STOP_DISPUTE')
  })

  condition('STOP_INVOICE_DISPUTE', 'stops when the invoice itself is disputed', () => {
    expect(run({ invoiceDisputed: true }).reason).toBe('STOP_INVOICE_DISPUTE')
  })

  condition('STOP_OPT_OUT', 'stops permanently after an opt-out', () => {
    expect(run({ optedOut: true }).reason).toBe('STOP_OPT_OUT')
  })

  condition('STOP_WRONG_PERSON', 'stops when we have reached the wrong person', () => {
    expect(run({ wrongPerson: true }).reason).toBe('STOP_WRONG_PERSON')
  })

  condition('STOP_DECEASED', 'stops on a bereavement signal', () => {
    expect(run({ deceased: true }).reason).toBe('STOP_DECEASED')
  })

  condition('STOP_VULNERABILITY', 'suppresses automation on a distress signal', () => {
    expect(run({ distressSignalled: true }).reason).toBe('STOP_VULNERABILITY')
  })

  condition('STOP_ABUSE', 'stops outbound after abuse toward the channel', () => {
    expect(run({ abuseSignalled: true }).reason).toBe('STOP_ABUSE')
  })

  condition('STOP_ATTEMPT_BUDGET', 'stops charging once the retry budget is spent', () => {
    const spent = run({ action: 'RETRY_CHARGE', retriesExcludingInfra: 4 })
    expect(spent.reason).toBe('STOP_ATTEMPT_BUDGET')

    const contactStillAllowed = run({ action: 'SEND_NUDGE', retriesExcludingInfra: 9 })
    expect(contactStillAllowed.verdict).toBe('CONTINUE')
  })

  condition('STOP_TOUCH_BUDGET', 'stops contacting once the touch budget is spent', () => {
    expect(run({ touchCount: 6 }).reason).toBe('STOP_TOUCH_BUDGET')
    expect(run({ action: 'RETRY_CHARGE', touchCount: 9 }).verdict).toBe('CONTINUE')
  })

  condition('STOP_EV_NEGATIVE', 'stops when nothing left is worth doing', () => {
    expect(run({ bestRemainingEvPaise: paise(0) }).reason).toBe('STOP_EV_NEGATIVE')
  })

  condition('STOP_UNECONOMIC', 'writes off an amount below the chasing floor', () => {
    expect(run({ outstandingPaise: paise(2_000), originalAmountPaise: paise(2_000) }).reason).toBe(
      'STOP_UNECONOMIC',
    )
  })

  condition('STOP_MANDATE_DEAD', 'blocks charging a dead mandate but allows repair contact', () => {
    expect(run({ action: 'RETRY_CHARGE', mandateDead: true }).reason).toBe('STOP_MANDATE_DEAD')
    expect(run({ action: 'MANDATE_REPAIR', mandateDead: true }).verdict).toBe('CONTINUE')
  })

  condition('STOP_RISK_FLAG', 'routes a flagged customer away from dunning', () => {
    expect(run({ riskFlagged: true }).reason).toBe('STOP_RISK_FLAG')
  })

  condition('STOP_COHORT_PAUSED', 'defers rather than stops when the route is paused', () => {
    const result = run({ action: 'RETRY_CHARGE', cohortPaused: true })
    expect(result.verdict).toBe('DEFER')
    expect(result.reason).toBeUndefined()
    expect(result.deferUntil).toBeGreaterThan(NOW)
  })

  condition('STOP_KILL_SWITCH', 'halts everything on a kill switch or merchant pause', () => {
    expect(run({ killSwitchEngaged: true }).reason).toBe('STOP_KILL_SWITCH')
    expect(run({ merchantPaused: true }).reason).toBe('STOP_KILL_SWITCH')
  })

  condition('STOP_PTP_ACTIVE', 'defers until the promise date plus grace', () => {
    const promiseDueAt = NOW + 3 * 24 * HOUR
    const result = run({ hasActivePromise: true, promiseDueAt })
    expect(result.verdict).toBe('DEFER')
    expect(result.deferUntil).toBe(promiseDueAt + authority.promises.grace_hours * HOUR)
  })
})

describe('stop gate behaviour', () => {
  it('records an evaluation for every condition, not just the failures', () => {
    const result = run()
    expect(result.evaluations).toHaveLength(STOP_CONDITION_IDS.length)
    expect(result.verdict).toBe('CONTINUE')
  })

  it('has a test for every registered condition', () => {
    expect(STOP_CONDITION_IDS.filter((id) => !COVERED.has(id))).toEqual([])
  })

  it('lets a stop outrank a deferral', () => {
    const result = run({ action: 'RETRY_CHARGE', cohortPaused: true, optedOut: true })
    expect(result.verdict).toBe('STOP')
    expect(result.deferUntil).toBeUndefined()
  })

  it('stops a case that has outlived the age limit', () => {
    const result = run({ caseAgeDays: authority.thresholds.case_age_limit_days + 1 })
    expect(result.verdict).toBe('STOP')
  })

  it('lets a silent retry proceed during a promise, but not a message', () => {
    expect(run({ action: 'RETRY_CHARGE', hasActivePromise: true }).verdict).toBe('CONTINUE')
    expect(run({ action: 'SEND_NUDGE', hasActivePromise: true }).verdict).toBe('DEFER')
  })

  it('is a pure function, so running it twice on the same state agrees', () => {
    const first = run({ touchCount: 2 })
    const second = run({ touchCount: 2 })
    expect(first).toEqual(second)
  })

  it('changes its mind when state changes between the two runs', () => {
    expect(run({ outstandingPaise: paise(250_000) }).verdict).toBe('CONTINUE')
    expect(run({ outstandingPaise: paise(0) }).verdict).toBe('STOP')
  })
})

describe('economic stops and the control baseline', () => {
  it('stops an agent case whose remaining actions are not worth taking', () => {
    const result = run({ bestRemainingEvPaise: paise(0), economicStopsApply: true })
    expect(result.reason).toBe('STOP_EV_NEGATIVE')
  })

  it('lets the control baseline run its schedule even when the economics look bad', () => {
    const result = run({ bestRemainingEvPaise: paise(0), economicStopsApply: false })
    expect(result.verdict).toBe('CONTINUE')
  })

  it('does not write off a small balance in the control arm', () => {
    const result = run({
      outstandingPaise: paise(2_000),
      originalAmountPaise: paise(2_000),
      economicStopsApply: false,
    })
    expect(result.verdict).toBe('CONTINUE')
  })

  it('still applies every safety stop to the control arm', () => {
    for (const overrides of [
      { optedOut: true },
      { deceased: true },
      { disputeOpen: true },
      { killSwitchEngaged: true },
    ]) {
      expect(run({ ...overrides, economicStopsApply: false }).verdict).toBe('STOP')
    }
  })
})
