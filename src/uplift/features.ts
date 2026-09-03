import { isBankingDay, isMonthEnd, isSalaryWindow, istHour, istWeekday } from '../core/calendar'
import type { Paise } from '../core/money'
import {
  ACTION_TYPES,
  CHANNELS,
  FAILURE_CLASSES,
  PAYMENT_METHODS,
  PORTFOLIOS,
  type ActionType,
  type Channel,
  type FailureClass,
  type PaymentMethod,
  type Portfolio,
} from '../domain/enums'
import { amountBand, AMOUNT_BANDS } from '../experiment/arm'

export interface CaseFeatures {
  readonly outstandingPaise: Paise
  readonly failureClass: FailureClass
  readonly portfolio: Portfolio
  readonly method: PaymentMethod | undefined
  readonly attemptCount: number
  readonly touchCount: number
  readonly daysSinceDue: number
  readonly at: number
}

export interface ActionFeatures {
  readonly action: ActionType
  readonly channel: Channel | undefined
}

export const BASELINE_ACTION: ActionFeatures = { action: 'WAIT', channel: undefined }

const CHARGE_ACTIONS = new Set<ActionType>([
  'RETRY_CHARGE',
  'RETRY_CHARGE_ALT_ROUTE',
  'SPLIT_RETRY',
])

const CONCESSION_ACTIONS = new Set<ActionType>([
  'OFFER_PART_PAYMENT',
  'OFFER_PLAN',
  'OFFER_DISCOUNT',
  'GRANT_EXTENSION',
])

const REPAIR_ACTIONS = new Set<ActionType>([
  'OFFER_METHOD_SWITCH',
  'REQUEST_INSTRUMENT_UPDATE',
  'MANDATE_REPAIR',
])

const ESCALATION_ACTIONS = new Set<ActionType>(['ESCALATE_CONTACT', 'ESCALATE_HUMAN'])

const PASSIVE_ACTIONS = new Set<ActionType>(['WAIT', 'STOP', 'WRITE_OFF'])

const ATTEMPT_CAP = 10
const TOUCH_CAP = 10
const DAYS_CAP = 90

function oneHot<T extends string>(values: readonly T[], value: T | undefined): number[] {
  return values.map((candidate) => (candidate === value ? 1 : 0))
}

export const CASE_FEATURE_NAMES: readonly string[] = [
  'log_outstanding',
  'attempt_count',
  'touch_count',
  'days_since_due',
  'touches_per_day',
  'hour_of_day',
  'weekday',
  'salary_window',
  'banking_day',
  'month_end',
  ...FAILURE_CLASSES.map((value) => `failure_${value}`),
  ...PORTFOLIOS.map((value) => `portfolio_${value}`),
  ...PAYMENT_METHODS.map((value) => `method_${value}`),
  ...AMOUNT_BANDS.map((value) => `band_${value}`),
]

export const ACTION_FEATURE_NAMES: readonly string[] = [
  ...ACTION_TYPES.map((value) => `action_${value}`),
  ...CHANNELS.map((value) => `channel_${value}`),
  'action_is_charge',
  'action_is_concession',
  'action_is_repair',
  'action_is_escalation',
  'action_is_passive',
  'action_is_contact',
]

export const FEATURE_NAMES: readonly string[] = [...CASE_FEATURE_NAMES, ...ACTION_FEATURE_NAMES]

function checkWidth(vector: readonly number[], names: readonly string[], label: string): void {
  if (vector.length !== names.length) {
    throw new Error(
      `${label} vector has ${vector.length} entries but ${names.length} names are declared; ` +
        `training and prediction would silently disagree`,
    )
  }
}

export function encodeCase(features: CaseFeatures): number[] {
  const touches = Math.min(TOUCH_CAP, features.touchCount)
  const days = Math.min(DAYS_CAP, features.daysSinceDue)

  const vector = [
    Math.log1p(features.outstandingPaise / 100),
    Math.min(ATTEMPT_CAP, features.attemptCount),
    touches,
    days,
    touches / (1 + days),
    istHour(features.at),
    istWeekday(features.at),
    isSalaryWindow(features.at) ? 1 : 0,
    isBankingDay(features.at) ? 1 : 0,
    isMonthEnd(features.at) ? 1 : 0,
    ...oneHot(FAILURE_CLASSES, features.failureClass),
    ...oneHot(PORTFOLIOS, features.portfolio),
    ...oneHot(PAYMENT_METHODS, features.method),
    ...oneHot(AMOUNT_BANDS, amountBand(features.outstandingPaise)),
  ]

  checkWidth(vector, CASE_FEATURE_NAMES, 'case feature')
  return vector
}

export function encodeAction(action: ActionFeatures): number[] {
  const vector = [
    ...oneHot(ACTION_TYPES, action.action),
    ...oneHot(CHANNELS, action.channel),
    CHARGE_ACTIONS.has(action.action) ? 1 : 0,
    CONCESSION_ACTIONS.has(action.action) ? 1 : 0,
    REPAIR_ACTIONS.has(action.action) ? 1 : 0,
    ESCALATION_ACTIONS.has(action.action) ? 1 : 0,
    PASSIVE_ACTIONS.has(action.action) ? 1 : 0,
    action.channel !== undefined && !PASSIVE_ACTIONS.has(action.action) ? 1 : 0,
  ]

  checkWidth(vector, ACTION_FEATURE_NAMES, 'action feature')
  return vector
}

export function encodeDecision(features: CaseFeatures, action: ActionFeatures): number[] {
  return [...encodeCase(features), ...encodeAction(action)]
}

export function actionKey(action: ActionFeatures): string {
  return `${action.action}|${action.channel ?? ''}`
}
