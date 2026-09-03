import { migrate } from 'drizzle-orm/libsql/migrator'

import { createDatabase, type DatabaseHandle } from '../../src/db/client'
import {
  consentRecords,
  customers,
  diagnoses,
  ledgerEvents,
  decisions,
  merchants,
  riskCases,
} from '../../src/db/schema'

export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = await createDatabase(':memory:')
  await migrate(handle.db, { migrationsFolder: './drizzle' })
  return handle
}

export async function seedMerchant(handle: DatabaseHandle, id = 'merch_test'): Promise<string> {
  await handle.db.insert(merchants).values({
    id,
    name: 'Test Merchant',
    timezone: 'Asia/Kolkata',
    marginRateBp: 3000,
    paused: false,
    createdAt: 0,
  })
  return id
}

export interface SeededCase {
  readonly merchantId: string
  readonly customerId: string
  readonly caseId: string
}

export async function seedCase(
  handle: DatabaseHandle,
  options: {
    merchantId?: string
    customerId?: string
    caseId?: string
    amountPaise?: number
    at?: number
    arm?: 'TREATMENT' | 'CONTROL'
    languagePref?: 'en' | 'hi' | 'hinglish'
  } = {},
): Promise<SeededCase> {
  const merchantId = options.merchantId ?? 'merch_test'
  const customerId = options.customerId ?? 'cust_1'
  const caseId = options.caseId ?? 'case_obl_1'
  const at = options.at ?? 0
  const amountPaise = options.amountPaise ?? 500_000

  await handle.db.insert(customers).values({
    id: customerId,
    merchantId,
    externalRef: `ext_${customerId}`,
    portfolio: 'd2c_subscription',
    languagePref: options.languagePref ?? 'en',
    createdAt: at,
  })

  for (const channel of ['SMS', 'WHATSAPP', 'EMAIL', 'VOICE'] as const) {
    await handle.db.insert(consentRecords).values({
      id: `consent_${customerId}_${channel}`,
      customerId,
      channel,
      granted: true,
      dnd: false,
      purpose: 'payment_recovery',
      source: 'checkout_terms',
      capturedAt: at,
    })
  }

  await handle.db.insert(riskCases).values({
    id: caseId,
    merchantId,
    customerId,
    type: 'SUBSCRIPTION_DUNNING',
    amountPaise,
    currency: 'INR',
    dueAt: at,
    sourceEntity: { subscriptionId: 'sub_1' },
    state: 'OPEN',
    arm: options.arm ?? 'TREATMENT',
    stratum: 'mid|FUNDS_TIMING',
    cohortId: 'upi|HDFC',
    policyVersion: 'test',
    firstSeenAt: at,
    updatedAt: at,
  })

  await handle.db.insert(ledgerEvents).values({
    id: `ledger_${caseId}`,
    caseId,
    merchantId,
    type: 'CHARGE',
    amountPaise,
    at,
    createdAt: at,
  })

  await handle.db.insert(diagnoses).values({
    id: `diag_${caseId}`,
    caseId,
    failureClass: 'FUNDS_TIMING',
    confidence: 0.97,
    evidence: [],
    method: 'TABLE',
    modelUsed: false,
    at,
  })

  return { merchantId, customerId, caseId }
}

export async function seedDecision(
  handle: DatabaseHandle,
  options: { id?: string; caseId?: string; at?: number } = {},
): Promise<string> {
  const id = options.id ?? 'decision_1'
  const at = options.at ?? 0

  await handle.db.insert(decisions).values({
    id,
    merchantId: 'merch_test',
    caseId: options.caseId ?? 'case_obl_1',
    at,
    clockMode: 'VIRTUAL',
    featureSnapshot: {},
    candidates: [],
    chosenAction: 'SEND_NUDGE',
    chosenBy: 'PLAYBOOK',
    propensity: 0.5,
    policyEvaluations: [],
    stopEvaluations: [],
    finalVerdict: 'EXECUTE',
    policyVersion: 'test',
    playbookVersion: 'test',
    prevHash: '0'.repeat(64),
    hash: `hash_${id}`,
  })

  return id
}
