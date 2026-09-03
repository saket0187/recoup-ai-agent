import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadAuthority } from '../src/core/config-files'
import { createRng } from '../src/core/seeded-random'
import type { DatabaseHandle } from '../src/db/client'
import { actions, contactEvents, decisions, riskCases } from '../src/db/schema'
import { measure } from '../src/measurement/metrics'
import { createTestDatabase, seedCase, seedMerchant } from './helpers/database'

const authority = loadAuthority()
const MERCHANT = 'merch_test'

let handle: DatabaseHandle

beforeEach(async () => {
  handle = await createTestDatabase()
  await seedMerchant(handle, MERCHANT)
})

afterEach(() => {
  handle.close()
})

async function addCase(options: {
  id: string
  arm: 'TREATMENT' | 'CONTROL'
  amountPaise: number
  recoveredPaise?: number
  touchCount?: number
}): Promise<void> {
  await seedCase(handle, {
    merchantId: MERCHANT,
    customerId: `cust_${options.id}`,
    caseId: options.id,
    amountPaise: options.amountPaise,
    arm: options.arm,
  })

  const recovered = options.recoveredPaise ?? 0
  await handle.db
    .update(riskCases)
    .set({
      recoveredPaise: recovered,
      state: recovered >= options.amountPaise ? 'RECOVERED' : 'IN_PROGRESS',
      resolvedAt: recovered >= options.amountPaise ? 10_000 : null,
      touchCount: options.touchCount ?? 0,
    })
    .where(eq(riskCases.id, options.id))
}

async function run() {
  return measure(handle.db, MERCHANT, authority, createRng(1).derive('test'), 200)
}

describe('measure: arm construction', () => {
  it('splits cases into the arm each was assigned to', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await addCase({ id: 'case_obl_t2', arm: 'TREATMENT', amountPaise: 100_000 })
    await addCase({ id: 'case_obl_c1', arm: 'CONTROL', amountPaise: 100_000 })

    const result = await run()
    expect(result.treatment.cases).toBe(2)
    expect(result.control.cases).toBe(1)
  })

  it('counts only fully recovered cases as recovered', async () => {
    await addCase({
      id: 'case_obl_a',
      arm: 'TREATMENT',
      amountPaise: 100_000,
      recoveredPaise: 100_000,
    })
    await addCase({
      id: 'case_obl_b',
      arm: 'TREATMENT',
      amountPaise: 100_000,
      recoveredPaise: 40_000,
    })

    const result = await run()
    expect(result.treatment.recovered).toBe(1)
  })

  it('reports a recovered fraction per case, capped at one', async () => {
    await addCase({
      id: 'case_obl_a',
      arm: 'TREATMENT',
      amountPaise: 100_000,
      recoveredPaise: 250_000,
    })
    const result = await run()
    expect(Math.max(...result.treatment.recoveredFractionPerCase)).toBe(1)
  })
})

describe('measure: the headline estimators', () => {
  it('reports a positive incremental fraction when treatment recovers more', async () => {
    for (let i = 0; i < 12; i++) {
      await addCase({
        id: `case_obl_t${i}`,
        arm: 'TREATMENT',
        amountPaise: 100_000,
        recoveredPaise: 100_000,
      })
    }
    for (let i = 0; i < 12; i++) {
      await addCase({ id: `case_obl_c${i}`, arm: 'CONTROL', amountPaise: 100_000 })
    }

    const result = await run()
    expect(result.incrementalRecoveredFraction.estimate).toBeGreaterThan(0.9)
    expect(result.incrementalPerCasePaise.estimate).toBeGreaterThan(0)
  })

  it('reports a negative incremental fraction when control recovers more', async () => {
    for (let i = 0; i < 12; i++) {
      await addCase({ id: `case_obl_t${i}`, arm: 'TREATMENT', amountPaise: 100_000 })
    }
    for (let i = 0; i < 12; i++) {
      await addCase({
        id: `case_obl_c${i}`,
        arm: 'CONTROL',
        amountPaise: 100_000,
        recoveredPaise: 100_000,
      })
    }

    const result = await run()
    expect(result.incrementalRecoveredFraction.estimate).toBeLessThan(-0.9)
  })

  it('nets spend off the gross estimator, so the two differ only by what was spent', async () => {
    await addCase({
      id: 'case_obl_t1',
      arm: 'TREATMENT',
      amountPaise: 100_000,
      recoveredPaise: 100_000,
    })
    await addCase({ id: 'case_obl_c1', arm: 'CONTROL', amountPaise: 100_000 })

    await handle.db.insert(decisions).values(decisionRow('dec_1', 'case_obl_t1'))
    await handle.db.insert(actions).values(actionRow('act_1', 'dec_1', 'case_obl_t1', 5_000))

    const result = await run()
    expect(result.treatment.contactCostPaise).toBe(5_000)
    expect(result.incrementalNetValuePerCasePaise.estimate).toBeLessThan(
      result.incrementalPerCasePaise.estimate,
    )
  })

  it('ignores the cost of actions that were never sent', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await addCase({ id: 'case_obl_c1', arm: 'CONTROL', amountPaise: 100_000 })

    await handle.db.insert(decisions).values(decisionRow('dec_1', 'case_obl_t1'))
    await handle.db
      .insert(actions)
      .values({ ...actionRow('act_1', 'dec_1', 'case_obl_t1', 9_999), status: 'SUPPRESSED' })

    const result = await run()
    expect(result.treatment.contactCostPaise).toBe(0)
  })
})

describe('measure: policy violations', () => {
  it('counts a send that went out against a recorded DENY', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await handle.db.insert(decisions).values({
      ...decisionRow('dec_1', 'case_obl_t1'),
      policyEvaluations: [
        {
          ruleId: 'QUIET_HOURS',
          action: 'SEND_NUDGE',
          channel: 'SMS',
          verdict: 'DENY',
          detail: 'x',
        },
      ],
    })
    await handle.db.insert(actions).values({
      ...actionRow('act_1', 'dec_1', 'case_obl_t1', 100),
      type: 'SEND_NUDGE',
      channel: 'SMS',
    })

    const result = await run()
    expect(result.policyViolations).toBe(1)
  })

  it('does not blame a send on a denial recorded against a different channel', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await handle.db.insert(decisions).values({
      ...decisionRow('dec_1', 'case_obl_t1'),
      policyEvaluations: [
        {
          ruleId: 'WA_SESSION_WINDOW',
          action: 'SEND_NUDGE',
          channel: 'WHATSAPP',
          verdict: 'DENY',
          detail: 'x',
        },
      ],
    })
    await handle.db.insert(actions).values({
      ...actionRow('act_1', 'dec_1', 'case_obl_t1', 100),
      type: 'SEND_NUDGE',
      channel: 'SMS',
    })

    const result = await run()
    expect(result.policyViolations).toBe(0)
  })

  it('does not count a denial when nothing was sent', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await handle.db.insert(decisions).values({
      ...decisionRow('dec_1', 'case_obl_t1'),
      policyEvaluations: [
        {
          ruleId: 'QUIET_HOURS',
          action: 'SEND_NUDGE',
          channel: 'SMS',
          verdict: 'DENY',
          detail: 'x',
        },
      ],
    })

    const result = await run()
    expect(result.policyViolations).toBe(0)
  })
})

describe('measure: integrity counters', () => {
  it('reports full propensity coverage when every decision logged one', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await handle.db.insert(decisions).values(decisionRow('dec_1', 'case_obl_t1'))
    const result = await run()
    expect(result.propensityCoverage).toBe(1)
    expect(result.decisionCount).toBe(1)
  })

  it('counts dead-lettered actions', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await handle.db.insert(decisions).values(decisionRow('dec_1', 'case_obl_t1'))
    await handle.db
      .insert(actions)
      .values({ ...actionRow('act_1', 'dec_1', 'case_obl_t1', 0), status: 'DEAD_LETTER' })

    const result = await run()
    expect(result.deadLetteredActions).toBe(1)
  })

  it('counts a contact sent after the case had already resolved as false dunning', async () => {
    await addCase({
      id: 'case_obl_t1',
      arm: 'TREATMENT',
      amountPaise: 100_000,
      recoveredPaise: 100_000,
    })
    await handle.db.insert(contactEvents).values({
      id: 'contact_1',
      merchantId: MERCHANT,
      caseId: 'case_obl_t1',
      customerId: 'cust_case_obl_t1',
      actionId: null,
      channel: 'SMS',
      direction: 'OUTBOUND',
      templateId: null,
      language: 'en',
      bodyHash: 'hash',
      body: 'hello',
      sentAt: 999_999,
      delivered: true,
      replied: false,
      intent: null,
      optOut: false,
    })

    const result = await run()
    expect(result.treatment.falseDunningContacts).toBe(1)
  })

  it('counts an opt-out recorded on a contact', async () => {
    await addCase({ id: 'case_obl_t1', arm: 'TREATMENT', amountPaise: 100_000 })
    await handle.db.insert(contactEvents).values({
      id: 'contact_1',
      merchantId: MERCHANT,
      caseId: 'case_obl_t1',
      customerId: 'cust_case_obl_t1',
      actionId: null,
      channel: 'SMS',
      direction: 'OUTBOUND',
      templateId: null,
      language: 'en',
      bodyHash: 'hash',
      body: 'hello',
      sentAt: 100,
      delivered: true,
      replied: false,
      intent: null,
      optOut: true,
    })

    const result = await run()
    expect(result.treatment.optOuts).toBe(1)
  })

  it('flags a case contacted beyond the configured touch cap', async () => {
    await addCase({
      id: 'case_obl_t1',
      arm: 'TREATMENT',
      amountPaise: 100_000,
      touchCount: authority.budgets.max_touches_per_case + 1,
    })
    const result = await run()
    expect(result.treatment.overContactIncidents).toBe(1)
  })
})

function decisionRow(id: string, caseId: string) {
  return {
    id,
    merchantId: MERCHANT,
    caseId,
    at: 100,
    clockMode: 'VIRTUAL',
    featureSnapshot: {},
    candidates: [],
    chosenAction: 'SEND_NUDGE' as const,
    chosenChannel: 'SMS' as const,
    chosenBy: 'PLAYBOOK' as const,
    propensity: 0.5,
    policyEvaluations: [],
    stopEvaluations: [],
    reviewerVerdict: null,
    reviewerReason: null,
    finalVerdict: 'EXECUTE' as const,
    deferUntil: null,
    suppressReason: null,
    policyVersion: 'test',
    playbookVersion: 'test',
    modelVersion: null,
    prevHash: `prev_${id}`,
    hash: `hash_${id}`,
  }
}

function actionRow(id: string, decisionId: string, caseId: string, costPaise: number) {
  return {
    id,
    merchantId: MERCHANT,
    decisionId,
    caseId,
    type: 'SEND_NUDGE' as const,
    channel: 'SMS' as const,
    templateId: null,
    language: 'en' as const,
    amountPaise: null,
    status: 'SENT' as const,
    scheduledFor: 100,
    attempts: 1,
    lastError: null,
    providerRef: null,
    costPaise,
    idempotencyKey: `idem_${id}`,
    dryRun: false,
    createdAt: 100,
    updatedAt: 100,
  }
}
