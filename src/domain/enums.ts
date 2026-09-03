export const PORTFOLIOS = ['d2c_subscription', 'one_time_checkout', 'b2b_invoice'] as const
export type Portfolio = (typeof PORTFOLIOS)[number]

export const LANGUAGES = ['en', 'hi', 'hinglish'] as const
export type Language = (typeof LANGUAGES)[number]

export const CASE_TYPES = [
  'FAILED_PAYMENT',
  'SUBSCRIPTION_DUNNING',
  'INVOICE_OVERDUE',
  'CHECKOUT_ABANDONED',
  'MANDATE_BROKEN',
  'DEGRADATION_COHORT',
] as const
export type CaseType = (typeof CASE_TYPES)[number]

export const CASE_STATES = [
  'OPEN',
  'IN_PROGRESS',
  'PTP_ACTIVE',
  'PAUSED_DOWNTIME',
  'AWAITING_HUMAN',
  'RECOVERED',
  'STOPPED',
  'WRITTEN_OFF',
] as const
export type CaseState = (typeof CASE_STATES)[number]

export const ARMS = ['TREATMENT', 'CONTROL'] as const
export type Arm = (typeof ARMS)[number]

export const FAILURE_CLASSES = [
  'TRANSIENT_INFRA',
  'FUNDS_TIMING',
  'AUTH_DROPOFF',
  'INSTRUMENT_INVALID',
  'MANDATE_BROKEN',
  'RISK_DECLINE',
  'MERCHANT_DEFECT',
  'AMBIGUOUS',
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

export const DIAGNOSIS_METHODS = ['TABLE', 'MODEL', 'HUMAN'] as const
export type DiagnosisMethod = (typeof DIAGNOSIS_METHODS)[number]

export const ACTION_TYPES = [
  'RETRY_CHARGE',
  'RETRY_CHARGE_ALT_ROUTE',
  'SPLIT_RETRY',
  'SEND_NUDGE',
  'SEND_PAYMENT_LINK',
  'SEND_PRE_DEBIT_NOTICE',
  'OFFER_METHOD_SWITCH',
  'REQUEST_INSTRUMENT_UPDATE',
  'MANDATE_REPAIR',
  'OFFER_PART_PAYMENT',
  'OFFER_PLAN',
  'OFFER_DISCOUNT',
  'GRANT_EXTENSION',
  'ESCALATE_CONTACT',
  'ESCALATE_HUMAN',
  'RAISE_ENG_TICKET',
  'PAUSE_COHORT',
  'RESUME_COHORT_CANARY',
  'STOP',
  'WRITE_OFF',
  'WAIT',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const ACTION_STATUSES = [
  'SCHEDULED',
  'IN_FLIGHT',
  'SENT',
  'FAILED',
  'CANCELLED',
  'SUPPRESSED',
  'DEAD_LETTER',
] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export const CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL', 'VOICE', 'IN_APP', 'HUMAN'] as const
export type Channel = (typeof CHANNELS)[number]

export const DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const
export type Direction = (typeof DIRECTIONS)[number]

export const CHOSEN_BY = ['PLAYBOOK', 'MODEL', 'HUMAN'] as const
export type ChosenBy = (typeof CHOSEN_BY)[number]

export const POLICY_VERDICTS = ['ALLOW', 'DEFER', 'DENY', 'MODIFY'] as const
export type PolicyVerdict = (typeof POLICY_VERDICTS)[number]

export const STOP_VERDICTS = ['CONTINUE', 'STOP', 'DEFER'] as const
export type StopVerdict = (typeof STOP_VERDICTS)[number]

export const REVIEWER_VERDICTS = ['PASS', 'BLOCK'] as const
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number]

export const FINAL_VERDICTS = ['EXECUTE', 'DEFER', 'SUPPRESS'] as const
export type FinalVerdict = (typeof FINAL_VERDICTS)[number]

export const STOP_REASONS = [
  'STOP_PAID',
  'STOP_PARTIAL',
  'STOP_DISPUTE',
  'STOP_INVOICE_DISPUTE',
  'STOP_OPT_OUT',
  'STOP_WRONG_PERSON',
  'STOP_DECEASED',
  'STOP_VULNERABILITY',
  'STOP_ABUSE',
  'STOP_ATTEMPT_BUDGET',
  'STOP_TOUCH_BUDGET',
  'STOP_EV_NEGATIVE',
  'STOP_UNECONOMIC',
  'STOP_MANDATE_DEAD',
  'STOP_RISK_FLAG',
  'STOP_COHORT_PAUSED',
  'STOP_KILL_SWITCH',
  'STOP_PTP_ACTIVE',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

export const LEDGER_EVENT_TYPES = [
  'CHARGE',
  'PAYMENT',
  'REFUND',
  'CREDIT_NOTE',
  'TDS_ADJUSTMENT',
  'WRITE_OFF',
] as const
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number]

export const PROMISE_SOURCES = ['TEXT', 'VOICE', 'HUMAN'] as const
export type PromiseSource = (typeof PROMISE_SOURCES)[number]

export const PROMISE_STATUSES = ['ACTIVE', 'KEPT', 'BROKEN', 'SUPERSEDED'] as const
export type PromiseStatus = (typeof PROMISE_STATUSES)[number]

export const COHORT_STATES = ['HEALTHY', 'DEGRADED', 'PAUSED', 'CANARY'] as const
export type CohortState = (typeof COHORT_STATES)[number]

export const INBOUND_INTENTS = [
  'WILL_PAY_NOW',
  'PROMISE_TO_PAY',
  'ALREADY_PAID',
  'DISPUTE_AMOUNT',
  'DISPUTE_SERVICE',
  'CANNOT_PAY',
  'REQUEST_PLAN',
  'REQUEST_HUMAN',
  'WRONG_PERSON',
  'OPT_OUT',
  'ABUSE',
  'DISTRESS',
  'UNCLEAR',
] as const
export type InboundIntent = (typeof INBOUND_INTENTS)[number]

export const AUDIT_ENTRY_TYPES = [
  'GENESIS',
  'CASE_OPENED',
  'DIAGNOSIS',
  'DECISION',
  'ACTION_SCHEDULED',
  'ACTION_EXECUTED',
  'ACTION_SUPPRESSED',
  'CONTACT_INBOUND',
  'LEDGER_EVENT',
  'PROMISE',
  'STATE_CHANGE',
  'COHORT_STATE_CHANGE',
  'HUMAN_REVIEW',
  'CONFIG_CHANGE',
] as const
export type AuditEntryType = (typeof AUDIT_ENTRY_TYPES)[number]

export const PAYMENT_METHODS = ['upi', 'card', 'netbanking', 'wallet', 'emandate', 'nach'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const ERROR_SOURCES = [
  'customer',
  'business',
  'bank',
  'issuer',
  'gateway',
  'network',
  'internal',
  'nbfc',
] as const
export type ErrorSource = (typeof ERROR_SOURCES)[number]

export const ERROR_STEPS = [
  'payment_initiation',
  'payment_authentication',
  'payment_authorization',
  'payment_capture',
] as const
export type ErrorStep = (typeof ERROR_STEPS)[number]

export const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'refunded', 'failed'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]
