import type { AuthorityConfig } from '../core/config-files'
import type { Paise } from '../core/money'
import type { ActionType, StopReason, StopVerdict } from '../domain/enums'
import type { StopEvaluation } from '../domain/records'
import { rungIndexOf } from './escalation'

const HOUR_MS = 3_600_000

export interface StopContext {
  readonly at: number
  readonly action: ActionType
  readonly outstandingPaise: Paise
  readonly originalAmountPaise: Paise
  readonly disputeOpen: boolean
  readonly invoiceDisputed: boolean
  readonly optedOut: boolean
  readonly wrongPerson: boolean
  readonly deceased: boolean
  readonly distressSignalled: boolean
  readonly abuseSignalled: boolean
  readonly retriesExcludingInfra: number
  readonly touchCount: number
  readonly bestRemainingEvPaise: Paise
  readonly mandateDead: boolean
  readonly riskFlagged: boolean
  readonly cohortPaused: boolean
  readonly killSwitchEngaged: boolean
  readonly merchantPaused: boolean
  readonly hasActivePromise: boolean
  readonly promiseDueAt: number | undefined
  readonly caseAgeDays: number
  readonly economicStopsApply: boolean
}

export interface StopResult {
  readonly verdict: StopVerdict
  readonly reason: StopReason | undefined
  readonly deferUntil: number | undefined
  readonly evaluations: readonly StopEvaluation[]
  readonly reAnchorAmount: boolean
}

interface Condition {
  readonly id: StopReason
  evaluate(context: StopContext, authority: AuthorityConfig): StopEvaluation
}

const CHARGE_ACTIONS = new Set<ActionType>([
  'RETRY_CHARGE',
  'RETRY_CHARGE_ALT_ROUTE',
  'SPLIT_RETRY',
])

function isOutbound(action: ActionType): boolean {
  return action !== 'WAIT' && action !== 'STOP' && action !== 'WRITE_OFF'
}

function evaluation(id: StopReason, verdict: StopVerdict, detail: string): StopEvaluation {
  return { ruleId: id, verdict, detail }
}

const CONDITIONS: readonly Condition[] = [
  {
    id: 'STOP_PAID',
    evaluate: (context) =>
      context.outstandingPaise <= 0
        ? evaluation('STOP_PAID', 'STOP', 'the ledger shows nothing outstanding')
        : evaluation('STOP_PAID', 'CONTINUE', `${context.outstandingPaise} paise outstanding`),
  },
  {
    id: 'STOP_PARTIAL',
    evaluate: (context) =>
      context.outstandingPaise > 0 && context.outstandingPaise < context.originalAmountPaise
        ? evaluation(
            'STOP_PARTIAL',
            'CONTINUE',
            'partially paid: continue, but re-anchor the amount and soften the tone',
          )
        : evaluation('STOP_PARTIAL', 'CONTINUE', 'no partial payment'),
  },
  {
    id: 'STOP_DISPUTE',
    evaluate: (context) =>
      context.disputeOpen
        ? evaluation('STOP_DISPUTE', 'STOP', 'a chargeback is open; freeze and route to a human')
        : evaluation('STOP_DISPUTE', 'CONTINUE', 'no chargeback'),
  },
  {
    id: 'STOP_INVOICE_DISPUTE',
    evaluate: (context) =>
      context.invoiceDisputed
        ? evaluation('STOP_INVOICE_DISPUTE', 'STOP', 'the invoice itself is disputed')
        : evaluation('STOP_INVOICE_DISPUTE', 'CONTINUE', 'invoice not disputed'),
  },
  {
    id: 'STOP_OPT_OUT',
    evaluate: (context) =>
      context.optedOut
        ? evaluation('STOP_OPT_OUT', 'STOP', 'the customer opted out; this is permanent and global')
        : evaluation('STOP_OPT_OUT', 'CONTINUE', 'no opt-out'),
  },
  {
    id: 'STOP_WRONG_PERSON',
    evaluate: (context) =>
      context.wrongPerson
        ? evaluation('STOP_WRONG_PERSON', 'STOP', 'contact details reached the wrong person')
        : evaluation('STOP_WRONG_PERSON', 'CONTINUE', 'contact believed correct'),
  },
  {
    id: 'STOP_DECEASED',
    evaluate: (context) =>
      context.deceased
        ? evaluation('STOP_DECEASED', 'STOP', 'bereavement signalled; human handling only')
        : evaluation('STOP_DECEASED', 'CONTINUE', 'no bereavement signal'),
  },
  {
    id: 'STOP_VULNERABILITY',
    evaluate: (context) =>
      context.distressSignalled
        ? evaluation('STOP_VULNERABILITY', 'STOP', 'distress signalled; suppress all automation')
        : evaluation('STOP_VULNERABILITY', 'CONTINUE', 'no distress signal'),
  },
  {
    id: 'STOP_ABUSE',
    evaluate: (context) =>
      context.abuseSignalled
        ? evaluation('STOP_ABUSE', 'STOP', 'abuse towards the channel; stop outbound and log')
        : evaluation('STOP_ABUSE', 'CONTINUE', 'no abuse signal'),
  },
  {
    id: 'STOP_ATTEMPT_BUDGET',
    evaluate: (context, authority) => {
      const cap = authority.budgets.max_retries_per_case
      if (!CHARGE_ACTIONS.has(context.action)) {
        return evaluation('STOP_ATTEMPT_BUDGET', 'CONTINUE', 'not a charge attempt')
      }
      return context.retriesExcludingInfra >= cap
        ? evaluation(
            'STOP_ATTEMPT_BUDGET',
            'STOP',
            `${context.retriesExcludingInfra} of ${cap} retries used`,
          )
        : evaluation(
            'STOP_ATTEMPT_BUDGET',
            'CONTINUE',
            `${context.retriesExcludingInfra} of ${cap} retries used`,
          )
    },
  },
  {
    id: 'STOP_TOUCH_BUDGET',
    evaluate: (context, authority) => {
      const cap = authority.budgets.max_touches_per_case
      if (!isOutbound(context.action) || CHARGE_ACTIONS.has(context.action)) {
        return evaluation('STOP_TOUCH_BUDGET', 'CONTINUE', 'not a customer touch')
      }
      return context.touchCount >= cap
        ? evaluation('STOP_TOUCH_BUDGET', 'STOP', `${context.touchCount} of ${cap} touches used`)
        : evaluation(
            'STOP_TOUCH_BUDGET',
            'CONTINUE',
            `${context.touchCount} of ${cap} touches used`,
          )
    },
  },
  {
    id: 'STOP_EV_NEGATIVE',
    evaluate: (context) => {
      if (!context.economicStopsApply) {
        return evaluation('STOP_EV_NEGATIVE', 'CONTINUE', 'economic stops do not bind this arm')
      }
      return context.bestRemainingEvPaise <= 0
        ? evaluation('STOP_EV_NEGATIVE', 'STOP', 'no remaining action has positive expected value')
        : evaluation(
            'STOP_EV_NEGATIVE',
            'CONTINUE',
            `best remaining EV ${context.bestRemainingEvPaise}`,
          )
    },
  },
  {
    id: 'STOP_UNECONOMIC',
    evaluate: (context, authority) => {
      if (!context.economicStopsApply) {
        return evaluation('STOP_UNECONOMIC', 'CONTINUE', 'economic stops do not bind this arm')
      }
      const floor = authority.thresholds.auto_write_off_below_paise
      return context.outstandingPaise > 0 && context.outstandingPaise < floor
        ? evaluation('STOP_UNECONOMIC', 'STOP', `outstanding is below the ${floor} write-off floor`)
        : evaluation('STOP_UNECONOMIC', 'CONTINUE', `outstanding is at or above the ${floor} floor`)
    },
  },
  {
    id: 'STOP_MANDATE_DEAD',
    evaluate: (context) => {
      if (!CHARGE_ACTIONS.has(context.action)) {
        return evaluation('STOP_MANDATE_DEAD', 'CONTINUE', 'not a charge attempt')
      }
      return context.mandateDead
        ? evaluation('STOP_MANDATE_DEAD', 'STOP', 'the mandate is dead; repair before charging')
        : evaluation('STOP_MANDATE_DEAD', 'CONTINUE', 'mandate is live')
    },
  },
  {
    id: 'STOP_RISK_FLAG',
    evaluate: (context) =>
      context.riskFlagged
        ? evaluation(
            'STOP_RISK_FLAG',
            'STOP',
            'fraud flag on the customer; route to the risk queue',
          )
        : evaluation('STOP_RISK_FLAG', 'CONTINUE', 'no fraud flag'),
  },
  {
    id: 'STOP_COHORT_PAUSED',
    evaluate: (context) => {
      if (!CHARGE_ACTIONS.has(context.action)) {
        return evaluation('STOP_COHORT_PAUSED', 'CONTINUE', 'not a charge attempt')
      }
      return context.cohortPaused
        ? evaluation('STOP_COHORT_PAUSED', 'DEFER', 'the route is paused; defer rather than stop')
        : evaluation('STOP_COHORT_PAUSED', 'CONTINUE', 'route is healthy')
    },
  },
  {
    id: 'STOP_KILL_SWITCH',
    evaluate: (context) =>
      context.killSwitchEngaged || context.merchantPaused
        ? evaluation(
            'STOP_KILL_SWITCH',
            'STOP',
            'execution is halted by a kill switch or merchant pause',
          )
        : evaluation('STOP_KILL_SWITCH', 'CONTINUE', 'no kill switch engaged'),
  },
  {
    id: 'STOP_PTP_ACTIVE',
    evaluate: (context) => {
      if (!context.hasActivePromise) {
        return evaluation('STOP_PTP_ACTIVE', 'CONTINUE', 'no active promise')
      }
      if (rungIndexOf(context.action) === 0) {
        return evaluation('STOP_PTP_ACTIVE', 'CONTINUE', 'silent action does not disturb a promise')
      }
      return evaluation('STOP_PTP_ACTIVE', 'DEFER', 'an unbroken promise to pay is active')
    },
  },
]

const VERDICT_RANK: Record<StopVerdict, number> = { CONTINUE: 0, DEFER: 1, STOP: 2 }

export function evaluateStopGate(context: StopContext, authority: AuthorityConfig): StopResult {
  const evaluations: StopEvaluation[] = []
  let verdict: StopVerdict = 'CONTINUE'
  let reason: StopReason | undefined
  let deferUntil: number | undefined

  for (const condition of CONDITIONS) {
    let outcome: StopEvaluation
    try {
      outcome = condition.evaluate(context, authority)
    } catch (cause) {
      outcome = evaluation(
        condition.id,
        'STOP',
        `condition threw and is treated as a stop: ${
          cause instanceof Error ? cause.message : 'unknown error'
        }`,
      )
    }

    evaluations.push(outcome)

    if (outcome.verdict === 'DEFER') {
      const until =
        condition.id === 'STOP_PTP_ACTIVE' && context.promiseDueAt !== undefined
          ? context.promiseDueAt + authority.promises.grace_hours * HOUR_MS
          : context.at + HOUR_MS
      deferUntil = deferUntil === undefined ? until : Math.max(deferUntil, until)
    }

    if (VERDICT_RANK[outcome.verdict] > VERDICT_RANK[verdict]) {
      verdict = outcome.verdict
      if (outcome.verdict === 'STOP') reason = condition.id
    }
  }

  const ageLimit = authority.thresholds.case_age_limit_days
  if (verdict !== 'STOP' && context.caseAgeDays > ageLimit) {
    verdict = 'STOP'
    reason = 'STOP_EV_NEGATIVE'
    evaluations.push(
      evaluation('STOP_EV_NEGATIVE', 'STOP', `case is older than the ${ageLimit}-day limit`),
    )
  }

  const partial =
    context.outstandingPaise > 0 && context.outstandingPaise < context.originalAmountPaise

  return {
    verdict,
    reason,
    deferUntil: verdict === 'STOP' ? undefined : deferUntil,
    evaluations,
    reAnchorAmount: partial,
  }
}

export const STOP_CONDITION_IDS: readonly StopReason[] = CONDITIONS.map((condition) => condition.id)
