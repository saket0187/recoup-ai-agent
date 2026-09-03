import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import {
  ACTION_STATUSES,
  ACTION_TYPES,
  ARMS,
  AUDIT_ENTRY_TYPES,
  CASE_STATES,
  CASE_TYPES,
  CHANNELS,
  CHOSEN_BY,
  COHORT_STATES,
  DIAGNOSIS_METHODS,
  DIRECTIONS,
  FAILURE_CLASSES,
  FINAL_VERDICTS,
  INBOUND_INTENTS,
  LANGUAGES,
  LEDGER_EVENT_TYPES,
  PAYMENT_METHODS,
  PORTFOLIOS,
  PROMISE_SOURCES,
  PROMISE_STATUSES,
  REVIEWER_VERDICTS,
  STOP_REASONS,
} from '../domain/enums'
import type {
  ActionCandidate,
  DiagnosisEvidence,
  FeatureSnapshot,
  PolicyEvaluation,
  ProviderErrorSignature,
  SourceEntity,
  StopEvaluation,
} from '../domain/records'

export const merchants = sqliteTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  marginRateBp: integer('margin_rate_bp').notNull().default(3000),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  tickLeaseUntil: integer('tick_lease_until'),
  createdAt: integer('created_at').notNull(),
})

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    externalRef: text('external_ref').notNull(),
    portfolio: text('portfolio', { enum: PORTFOLIOS }).notNull(),
    languagePref: text('language_pref', { enum: LANGUAGES }).notNull().default('en'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    optedOutGlobal: integer('opted_out_global', { mode: 'boolean' }).notNull().default(false),
    dnd: integer('dnd', { mode: 'boolean' }).notNull().default(false),
    riskFlagged: integer('risk_flagged', { mode: 'boolean' }).notNull().default(false),
    deceased: integer('deceased', { mode: 'boolean' }).notNull().default(false),
    contactDataSuspect: integer('contact_data_suspect', { mode: 'boolean' })
      .notNull()
      .default(false),
    trustScore: integer('trust_score').notNull().default(50),
    priorBillsSettled: integer('prior_bills_settled').notNull().default(0),
    priorBillsPaid: integer('prior_bills_paid').notNull().default(0),
    mandateCapPaise: integer('mandate_cap_paise'),
    erasureRequestedAt: integer('erasure_requested_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('customers_merchant_ref_uq').on(t.merchantId, t.externalRef),
    index('customers_merchant_idx').on(t.merchantId),
    check('customers_trust_score_ck', sql`${t.trustScore} between 0 and 100`),
  ],
)

export const consentRecords = sqliteTable(
  'consent_records',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    granted: integer('granted', { mode: 'boolean' }).notNull(),
    dnd: integer('dnd', { mode: 'boolean' }).notNull().default(false),
    purpose: text('purpose').notNull(),
    source: text('source').notNull(),
    capturedAt: integer('captured_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('consent_customer_channel_idx').on(t.customerId, t.channel),
    index('consent_captured_idx').on(t.capturedAt),
  ],
)

export const riskCases = sqliteTable(
  'risk_cases',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    type: text('type', { enum: CASE_TYPES }).notNull(),
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    dueAt: integer('due_at').notNull(),
    sourceEntity: text('source_entity', { mode: 'json' }).$type<SourceEntity>().notNull(),
    state: text('state', { enum: CASE_STATES }).notNull().default('OPEN'),
    stopReason: text('stop_reason', { enum: STOP_REASONS }),
    arm: text('arm', { enum: ARMS }).notNull(),
    stratum: text('stratum').notNull(),
    cohortId: text('cohort_id'),
    disputeOpenedAt: integer('dispute_opened_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    touchCount: integer('touch_count').notNull().default(0),
    recoveredPaise: integer('recovered_paise').notNull().default(0),
    costPaise: integer('cost_paise').notNull().default(0),
    policyVersion: text('policy_version').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    nextDecisionAt: integer('next_decision_at'),
    resolvedAt: integer('resolved_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('risk_cases_state_idx').on(t.state),
    index('risk_cases_customer_idx').on(t.customerId),
    index('risk_cases_merchant_state_idx').on(t.merchantId, t.state),
    index('risk_cases_resolved_idx').on(t.resolvedAt),
    index('risk_cases_due_idx').on(t.state, t.nextDecisionAt),
    index('risk_cases_arm_idx').on(t.arm),
    check('risk_cases_amount_ck', sql`${t.amountPaise} > 0`),
    check('risk_cases_counts_ck', sql`${t.attemptCount} >= 0 and ${t.touchCount} >= 0`),
  ],
)

export const ledgerEvents = sqliteTable(
  'ledger_events',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => riskCases.id),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    type: text('type', { enum: LEDGER_EVENT_TYPES }).notNull(),
    amountPaise: integer('amount_paise').notNull(),
    at: integer('at').notNull(),
    ref: text('ref'),
    providerRef: text('provider_ref'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('ledger_case_at_idx').on(t.caseId, t.at),
    uniqueIndex('ledger_provider_ref_uq').on(t.providerRef),
    check('ledger_amount_nonzero_ck', sql`${t.amountPaise} <> 0`),
    check(
      'ledger_sign_ck',
      sql`(${t.type} in ('CHARGE', 'REFUND') and ${t.amountPaise} > 0)
          or (${t.type} in ('PAYMENT', 'CREDIT_NOTE', 'TDS_ADJUSTMENT', 'WRITE_OFF') and ${t.amountPaise} < 0)`,
    ),
  ],
)

export const diagnoses = sqliteTable(
  'diagnoses',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => riskCases.id),
    failureClass: text('failure_class', { enum: FAILURE_CLASSES }).notNull(),
    confidence: real('confidence').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<DiagnosisEvidence[]>().notNull(),
    signature: text('signature', { mode: 'json' }).$type<ProviderErrorSignature>(),
    attributedTo: text('attributed_to'),
    cohortId: text('cohort_id'),
    method: text('method', { enum: DIAGNOSIS_METHODS }).notNull(),
    modelUsed: integer('model_used', { mode: 'boolean' }).notNull().default(false),
    modelVersion: text('model_version'),
    at: integer('at').notNull(),
  },
  (t) => [
    index('diagnoses_case_idx').on(t.caseId),
    index('diagnoses_class_idx').on(t.failureClass),
    check('diagnoses_confidence_ck', sql`${t.confidence} between 0 and 1`),
  ],
)

export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => riskCases.id),
    at: integer('at').notNull(),
    clockMode: text('clock_mode').notNull(),
    featureSnapshot: text('feature_snapshot', { mode: 'json' }).$type<FeatureSnapshot>().notNull(),
    candidates: text('candidates', { mode: 'json' }).$type<ActionCandidate[]>().notNull(),
    chosenAction: text('chosen_action', { enum: ACTION_TYPES }).notNull(),
    chosenChannel: text('chosen_channel', { enum: CHANNELS }),
    chosenBy: text('chosen_by', { enum: CHOSEN_BY }).notNull(),
    propensity: real('propensity').notNull(),
    policyEvaluations: text('policy_evaluations', { mode: 'json' })
      .$type<PolicyEvaluation[]>()
      .notNull(),
    stopEvaluations: text('stop_evaluations', { mode: 'json' }).$type<StopEvaluation[]>().notNull(),
    reviewerVerdict: text('reviewer_verdict', { enum: REVIEWER_VERDICTS }),
    reviewerReason: text('reviewer_reason'),
    finalVerdict: text('final_verdict', { enum: FINAL_VERDICTS }).notNull(),
    deferUntil: integer('defer_until'),
    suppressReason: text('suppress_reason'),
    policyVersion: text('policy_version').notNull(),
    playbookVersion: text('playbook_version').notNull(),
    modelVersion: text('model_version'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('decisions_case_at_idx').on(t.caseId, t.at),
    index('decisions_merchant_at_idx').on(t.merchantId, t.at),
    uniqueIndex('decisions_hash_uq').on(t.hash),
    check('decisions_propensity_ck', sql`${t.propensity} > 0 and ${t.propensity} <= 1`),
  ],
)

export const actions = sqliteTable(
  'actions',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    decisionId: text('decision_id')
      .notNull()
      .references(() => decisions.id),
    caseId: text('case_id')
      .notNull()
      .references(() => riskCases.id),
    type: text('type', { enum: ACTION_TYPES }).notNull(),
    channel: text('channel', { enum: CHANNELS }),
    templateId: text('template_id'),
    language: text('language', { enum: LANGUAGES }),
    amountPaise: integer('amount_paise'),
    scheduledFor: integer('scheduled_for').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    bestRemainingEvPaise: integer('best_remaining_ev_paise').notNull().default(0),
    status: text('status', { enum: ACTION_STATUSES }).notNull().default('SCHEDULED'),
    attempts: integer('attempts').notNull().default(0),
    providerRef: text('provider_ref'),
    costPaise: integer('cost_paise').notNull().default(0),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
    lastError: text('last_error'),
    executedAt: integer('executed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('actions_idempotency_uq').on(t.idempotencyKey),
    index('actions_due_idx').on(t.status, t.scheduledFor),
    index('actions_case_idx').on(t.caseId),
    index('actions_merchant_status_idx').on(t.merchantId, t.status),
    check('actions_attempts_ck', sql`${t.attempts} >= 0`),
  ],
)

export const contactEvents = sqliteTable(
  'contact_events',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    caseId: text('case_id')
      .notNull()
      .references(() => riskCases.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    actionId: text('action_id').references(() => actions.id),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    direction: text('direction', { enum: DIRECTIONS }).notNull(),
    templateId: text('template_id'),
    language: text('language', { enum: LANGUAGES }).notNull(),
    bodyHash: text('body_hash').notNull(),
    body: text('body'),
    sentAt: integer('sent_at').notNull(),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    replied: integer('replied', { mode: 'boolean' }).notNull().default(false),
    intent: text('intent', { enum: INBOUND_INTENTS }),
    optOut: integer('opt_out', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('contact_case_sent_idx').on(t.caseId, t.sentAt),
    index('contact_customer_sent_idx').on(t.customerId, t.sentAt),
    index('contact_channel_sent_idx').on(t.channel, t.sentAt),
    index('contact_merchant_sent_idx').on(t.merchantId, t.sentAt),
  ],
)

export const promises = sqliteTable(
  'promises',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => riskCases.id),
    amountPaise: integer('amount_paise').notNull(),
    promisedDate: integer('promised_date').notNull(),
    source: text('source', { enum: PROMISE_SOURCES }).notNull(),
    confidence: real('confidence').notNull(),
    status: text('status', { enum: PROMISE_STATUSES }).notNull().default('ACTIVE'),
    supersededBy: text('superseded_by'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [
    index('promises_case_status_idx').on(t.caseId, t.status),
    index('promises_due_idx').on(t.promisedDate),
    check('promises_confidence_ck', sql`${t.confidence} between 0 and 1`),
    check('promises_amount_ck', sql`${t.amountPaise} > 0`),
  ],
)

export const cohorts = sqliteTable(
  'cohorts',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    key: text('key').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    issuer: text('issuer'),
    windowStart: integer('window_start').notNull(),
    windowEnd: integer('window_end').notNull(),
    attempts: integer('attempts').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    wilsonLcb: real('wilson_lcb').notNull().default(0),
    baselineEwma: real('baseline_ewma').notNull().default(0),
    state: text('state', { enum: COHORT_STATES }).notNull().default('HEALTHY'),
    since: integer('since').notNull(),
    pausedUntil: integer('paused_until'),
    canaryPct: real('canary_pct'),
  },
  (t) => [
    uniqueIndex('cohorts_merchant_key_window_uq').on(t.merchantId, t.key, t.windowStart),
    index('cohorts_state_idx').on(t.state),
    check('cohorts_successes_ck', sql`${t.successes} >= 0 and ${t.successes} <= ${t.attempts}`),
  ],
)

export const auditRecords = sqliteTable(
  'audit_records',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    seq: integer('seq').notNull(),
    at: integer('at').notNull(),
    entryType: text('entry_type', { enum: AUDIT_ENTRY_TYPES }).notNull(),
    caseId: text('case_id'),
    subjectId: text('subject_id'),
    actor: text('actor').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    uniqueIndex('audit_merchant_seq_uq').on(t.merchantId, t.seq),
    uniqueIndex('audit_hash_uq').on(t.hash),
    index('audit_case_idx').on(t.caseId),
    index('audit_at_idx').on(t.at),
    check('audit_seq_ck', sql`${t.seq} >= 0`),
  ],
)

export const providerEvents = sqliteTable(
  'provider_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    entityId: text('entity_id'),
    payloadHash: text('payload_hash').notNull(),
    rawBody: text('raw_body').notNull(),
    providerCreatedAt: integer('provider_created_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at'),
    processingError: text('processing_error'),
  },
  (t) => [
    uniqueIndex('provider_events_uq').on(t.provider, t.eventId),
    index('provider_events_unprocessed_idx').on(t.processedAt),
    index('provider_events_entity_idx').on(t.entityId),
  ],
)

export const banditArms = sqliteTable(
  'bandit_arms',
  {
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    armKey: text('arm_key').notNull(),
    successes: integer('successes').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.merchantId, t.armKey] }),
    check('bandit_arms_successes_ck', sql`${t.successes} >= 0`),
    check('bandit_arms_failures_ck', sql`${t.failures} >= 0`),
  ],
)

export const schema = {
  banditArms,
  merchants,
  customers,
  consentRecords,
  riskCases,
  ledgerEvents,
  diagnoses,
  decisions,
  actions,
  contactEvents,
  promises,
  cohorts,
  auditRecords,
  providerEvents,
}

export type Merchant = typeof merchants.$inferSelect
export type Customer = typeof customers.$inferSelect
export type ConsentRecord = typeof consentRecords.$inferSelect
export type RiskCase = typeof riskCases.$inferSelect
export type LedgerEvent = typeof ledgerEvents.$inferSelect
export type Diagnosis = typeof diagnoses.$inferSelect
export type Decision = typeof decisions.$inferSelect
export type ActionRow = typeof actions.$inferSelect
export type ContactEvent = typeof contactEvents.$inferSelect
export type PromiseRow = typeof promises.$inferSelect
export type Cohort = typeof cohorts.$inferSelect
export type AuditRecord = typeof auditRecords.$inferSelect
export type ProviderEvent = typeof providerEvents.$inferSelect
export type BanditArm = typeof banditArms.$inferSelect

export type NewMerchant = typeof merchants.$inferInsert
export type NewCustomer = typeof customers.$inferInsert
export type NewRiskCase = typeof riskCases.$inferInsert
export type NewLedgerEvent = typeof ledgerEvents.$inferInsert
export type NewDecision = typeof decisions.$inferInsert
export type NewAction = typeof actions.$inferInsert
export type NewAuditRecord = typeof auditRecords.$inferInsert
