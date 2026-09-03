import type { ActionType, Channel, FailureClass } from '../domain/enums'

export const PLAYBOOK_VERSION = '2026.08.29-1'

export interface CandidateSpec {
  readonly action: ActionType
  readonly channel: Channel | undefined
  readonly rationale: string
  readonly operational?: boolean
}

export interface PlaybookInputs {
  readonly failureClass: FailureClass
  readonly attemptCount: number
  readonly touchCount: number
  readonly cohortPaused: boolean
  readonly mandateCapExceeded: boolean
  readonly preferredChannel: Channel
}

const WAIT_CANDIDATE: CandidateSpec = {
  action: 'WAIT',
  channel: undefined,
  rationale: 'doing nothing is always a candidate and is often the highest-value one',
}

function contact(action: ActionType, channel: Channel, rationale: string): CandidateSpec {
  return { action, channel, rationale }
}

function silent(action: ActionType, rationale: string): CandidateSpec {
  return { action, channel: undefined, rationale }
}

function operational(action: ActionType, rationale: string): CandidateSpec {
  return { action, channel: undefined, rationale, operational: true }
}

const ESCALATE_AFTER_TOUCHES = 3

const OUR_OWN_FAULT = new Set<FailureClass>(['TRANSIENT_INFRA', 'MERCHANT_DEFECT'])

export function candidatesFor(inputs: PlaybookInputs): CandidateSpec[] {
  const channel = inputs.preferredChannel
  const candidates: CandidateSpec[] = [WAIT_CANDIDATE]

  switch (inputs.failureClass) {
    case 'TRANSIENT_INFRA':
      if (!inputs.cohortPaused) {
        candidates.push(
          silent(
            'RETRY_CHARGE',
            'infrastructure failure; retry costs nothing and does not count against the budget',
          ),
        )
      }
      candidates.push(
        operational(
          'PAUSE_COHORT',
          'if the whole route is failing, pause it rather than retrying into it',
        ),
      )
      break

    case 'FUNDS_TIMING':
      candidates.push(
        silent('RETRY_CHARGE', 'balance may have recovered; time the retry into the salary window'),
        contact(
          'SEND_PRE_DEBIT_NOTICE',
          channel,
          'a heads-up before the debit lifts success because people top up',
        ),
      )
      if (inputs.attemptCount >= 3) {
        candidates.push(
          contact(
            'OFFER_PART_PAYMENT',
            channel,
            'three failed attempts on funds; a smaller amount may clear',
          ),
          contact(
            'OFFER_PLAN',
            channel,
            'spread the amount over instalments they can actually meet',
          ),
        )
      }
      break

    case 'AUTH_DROPOFF':
      candidates.push(
        contact(
          'SEND_PAYMENT_LINK',
          channel,
          'intent was warm; a UPI-intent link skips the step that failed',
        ),
        contact(
          'OFFER_METHOD_SWITCH',
          channel,
          'the route that failed authentication is unlikely to succeed again',
        ),
      )
      if (inputs.touchCount < 2) {
        candidates.push(
          contact('SEND_NUDGE', channel, 'a single reminder while intent is still warm'),
        )
      }
      break

    case 'INSTRUMENT_INVALID':
      candidates.push(
        contact(
          'REQUEST_INSTRUMENT_UPDATE',
          channel,
          'there is no reliable account updater here; we have to ask',
        ),
        contact('OFFER_METHOD_SWITCH', channel, 'lead with UPI AutoPay as the replacement mandate'),
      )
      break

    case 'MANDATE_BROKEN':
      candidates.push(
        contact(
          'MANDATE_REPAIR',
          channel,
          'the mandate must be re-established before any charge can work',
        ),
      )
      if (inputs.mandateCapExceeded) {
        candidates.push(
          silent(
            'SPLIT_RETRY',
            'the amount exceeds our own mandate cap; split rather than blame the customer',
          ),
        )
      }
      break

    case 'RISK_DECLINE':
      if (inputs.attemptCount < 1) {
        candidates.push(
          silent(
            'RETRY_CHARGE_ALT_ROUTE',
            'one alternative route, then stop; repeated tries look like card testing',
          ),
        )
      }
      candidates.push(
        silent('ESCALATE_HUMAN', 'risk declines need a person, not a dunning sequence'),
      )
      break

    case 'MERCHANT_DEFECT':
      candidates.push(
        operational(
          'RAISE_ENG_TICKET',
          'our own request was malformed; this is an engineering fix, not a customer problem',
        ),
        silent('RETRY_CHARGE', 'retry silently once the defect is corrected'),
      )
      break

    case 'AMBIGUOUS':
      candidates.push(
        silent('RETRY_CHARGE', 'one conservative retry while the signature is unclassified'),
        silent('ESCALATE_HUMAN', 'unmapped failures go to a person rather than a guess'),
      )
      break
  }

  if (
    inputs.touchCount >= ESCALATE_AFTER_TOUCHES &&
    !OUR_OWN_FAULT.has(inputs.failureClass) &&
    !inputs.cohortPaused
  ) {
    candidates.push(
      contact(
        'ESCALATE_CONTACT',
        'VOICE',
        'written reminders have not landed; a call is the next rung and the last one before a person',
      ),
    )
  }

  return candidates
}
