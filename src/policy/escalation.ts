import type { ActionType } from '../domain/enums'

export const RUNGS = [
  'SILENT_RETRY',
  'GENTLE_REMINDER',
  'FIRM_REMINDER',
  'OFFER',
  'HUMAN_CONTACT',
  'FORMAL_NOTICE',
] as const

export type Rung = (typeof RUNGS)[number]

const RUNG_BY_ACTION: Readonly<Record<ActionType, Rung>> = {
  RETRY_CHARGE: 'SILENT_RETRY',
  RETRY_CHARGE_ALT_ROUTE: 'SILENT_RETRY',
  SPLIT_RETRY: 'SILENT_RETRY',
  RAISE_ENG_TICKET: 'SILENT_RETRY',
  PAUSE_COHORT: 'SILENT_RETRY',
  RESUME_COHORT_CANARY: 'SILENT_RETRY',
  WAIT: 'SILENT_RETRY',
  STOP: 'SILENT_RETRY',
  WRITE_OFF: 'SILENT_RETRY',

  SEND_NUDGE: 'GENTLE_REMINDER',
  SEND_PRE_DEBIT_NOTICE: 'GENTLE_REMINDER',
  SEND_PAYMENT_LINK: 'GENTLE_REMINDER',
  REQUEST_INSTRUMENT_UPDATE: 'GENTLE_REMINDER',
  MANDATE_REPAIR: 'GENTLE_REMINDER',
  OFFER_METHOD_SWITCH: 'GENTLE_REMINDER',

  ESCALATE_CONTACT: 'FIRM_REMINDER',

  OFFER_PART_PAYMENT: 'OFFER',
  OFFER_PLAN: 'OFFER',
  OFFER_DISCOUNT: 'OFFER',
  GRANT_EXTENSION: 'OFFER',

  ESCALATE_HUMAN: 'HUMAN_CONTACT',
}

function rungOf(action: ActionType): Rung {
  return RUNG_BY_ACTION[action]
}

function rungIndex(rung: Rung): number {
  return RUNGS.indexOf(rung)
}

export function rungIndexOf(action: ActionType): number {
  return rungIndex(rungOf(action))
}
