import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { loadAuthority, loadCosts, loadPolicy } from '../src/core/config-files'
import { TemplateRegistry, loadTemplates } from '../src/content/templates'
import { fromIst } from '../src/core/calendar'
import { VirtualClock } from '../src/core/clock'
import { createIdFactory } from '../src/core/identifiers'
import { silentLogger } from '../src/core/logger'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import { ThompsonBandit } from '../src/decision/bandit'
import { AttributionTracker } from '../src/decision/feedback'
import { AuditChain } from '../src/db/audit-chain'
import type { DatabaseHandle } from '../src/db/client'
import { actions, auditRecords, decisions, riskCases } from '../src/db/schema'
import { Executor } from '../src/execution/executor'
import { Outbox } from '../src/execution/outbox'
import { ContextBuilder, type WorldFacts } from '../src/engine/context-builder'
import { Orchestrator } from '../src/engine/orchestrator'
import { LedgerRepository } from '../src/ledger/ledger'
import { PolicyEngine } from '../src/policy/engine'
import type { MessageSender, PaymentExecutor, SendRequest, SendResult } from '../src/providers/port'
import { createTestDatabase, seedCase, seedMerchant } from './helpers/database'

const authority = loadAuthority()
const costs = loadCosts()
const policy = loadPolicy()
const templates = loadTemplates()

const AT = fromIst(2026, 9, 15, 11)

describe('TemplateRegistry', () => {
  it('fills the amount slot from the ledger figure it is given', () => {
    const rendered = templates.render('SEND_NUDGE', 'en', {
      amountPaise: paise(123_456),
      merchantName: 'Acme',
      link: 'https://pay.example/x',
      dueAt: AT,
      extensionDays: undefined,
    })
    expect(rendered.body).toContain('₹1,234.56')
    expect(rendered.body).toContain('Acme')
    expect(rendered.amountPaise).toBe(123_456)
  })

  it('refuses to send a message with an unfilled slot', () => {
    expect(() =>
      templates.render('GRANT_EXTENSION', 'en', {
        amountPaise: paise(1_000),
        merchantName: 'Acme',
        link: 'x',
        dueAt: AT,
        extensionDays: undefined,
      }),
    ).toThrow(/days/)
  })

  it('rejects a registry missing a translation, rather than failing at send time', () => {
    expect(
      () =>
        new TemplateRegistry(`
templates_version: "x"
templates:
  - id: PARTIAL
    actions: [SEND_NUDGE]
    rung: GENTLE_REMINDER
    includes_offer: false
    bodies:
      en: "hello"
`),
    ).toThrow(/has no hi body/)
  })

  it('rejects two templates claiming the same action', () => {
    expect(
      () =>
        new TemplateRegistry(`
templates_version: "x"
templates:
  - id: A
    actions: [SEND_NUDGE]
    rung: GENTLE_REMINDER
    includes_offer: false
    bodies: { en: "a", hi: "a", hinglish: "a" }
  - id: B
    actions: [SEND_NUDGE]
    rung: GENTLE_REMINDER
    includes_offer: false
    bodies: { en: "b", hi: "b", hinglish: "b" }
`),
    ).toThrow(/Two templates claim/)
  })

  it('carries an offer flag so the promotional rule can reclassify', () => {
    const slots = {
      amountPaise: paise(1_000),
      merchantName: 'Acme',
      link: 'x',
      dueAt: AT,
      extensionDays: 7,
    }
    expect(templates.render('SEND_NUDGE', 'en', slots).includesOffer).toBe(false)
    expect(templates.render('OFFER_DISCOUNT', 'en', slots).includesOffer).toBe(true)
  })
})

describe('engine integration', () => {
  let handle: DatabaseHandle
  let clock: VirtualClock
  let orchestrator: Orchestrator
  let outbox: Outbox
  let contexts: ContextBuilder
  let facts: WorldFacts

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle)
    await seedCase(handle, { at: AT - 3 * 86_400_000, amountPaise: 2_000_000 })

    clock = new VirtualClock({ start: AT })
    const ids = createIdFactory('engine-test')
    const rng = createRng(42)
    const ledger = new LedgerRepository(handle.db, ids)

    facts = {
      bankHolidays: new Set(),
      pausedCohorts: new Set(),
      killSwitchEngaged: false,
      merchantPaused: false,
      isFestival: () => false,
    }

    contexts = new ContextBuilder(handle.db, clock, ledger, () => facts)
    outbox = new Outbox(handle.db, clock, ids)

    orchestrator = new Orchestrator({
      db: handle.db,
      clock,
      ids,
      rng,
      logger: silentLogger,
      merchantId: 'merch_test',
      merchantName: 'Acme',
      policy: new PolicyEngine(policy, authority, facts.bankHolidays),
      authority,
      costs,
      bandit: new ThompsonBandit(rng.derive('bandit')),
      templates,
      contexts,
      audit: new AuditChain(handle.db, clock, ids),
      attribution: new AttributionTracker(new ThompsonBandit(rng.derive('fb')), 72 * 3_600_000),
      dryRun: false,
      enqueue: (request) => outbox.enqueue(request),
    })
  })

  afterEach(() => handle.close())

  it('finds the open case and decides on it', async () => {
    const stats = await orchestrator.runCycle(AT)
    expect(stats.considered).toBe(1)
    expect(stats.decided).toBe(1)
  })

  it('persists a decision with a real propensity and every gate evaluation', async () => {
    await orchestrator.decideCase('case_obl_1')

    const rows = await handle.db.select().from(decisions)
    expect(rows).toHaveLength(1)

    const row = rows[0]
    expect(row?.propensity).toBeGreaterThan(0)
    expect(row?.propensity).toBeLessThanOrEqual(1)
    expect(row?.stopEvaluations).toHaveLength(18)
    expect(row?.candidates.length).toBeGreaterThan(1)
    expect(row?.policyVersion).toBe(policy.policy_version)
  })

  it('links every decision into the merchant audit chain', async () => {
    await orchestrator.decideCase('case_obl_1')

    const chain = new AuditChain(handle.db, clock, createIdFactory('verify'))
    const result = await chain.verify('merch_test')

    expect(result.intact).toBe(true)
    expect(result.recordsChecked).toBeGreaterThanOrEqual(2)

    const decisionRow = (await handle.db.select().from(decisions))[0]
    const auditRow = (await handle.db.select().from(auditRecords)).find(
      (record) => record.entryType === 'DECISION',
    )
    expect(decisionRow?.hash).toBe(auditRow?.hash)
  })

  it('cannot write an action that no decision authorised', async () => {
    await expect(
      outbox.enqueue({
        decisionId: 'decision_that_does_not_exist',
        caseId: 'case_obl_1',
        type: 'SEND_NUDGE',
        channel: 'WHATSAPP',
        templateId: 'NUDGE',
        language: 'en',
        amountPaise: paise(1),
        scheduledFor: AT,
        merchantId: 'merch_test',
        idempotencyKey: 'orphan',
        bestRemainingEvPaise: 10_000,
        dryRun: false,
      }),
    ).rejects.toThrow()
  })

  it('moves an open case to in-progress and refuses to decide a terminal one', async () => {
    await orchestrator.decideCase('case_obl_1')
    expect((await contexts.load('case_obl_1'))?.row.state).toBe('IN_PROGRESS')

    await handle.db
      .update(riskCases)
      .set({ state: 'RECOVERED', resolvedAt: AT })
      .where(eq(riskCases.id, 'case_obl_1'))

    expect(await orchestrator.decideCase('case_obl_1')).toBeUndefined()
  })

  it('quotes the live ledger amount in the message it enqueues', async () => {
    const outcome = await orchestrator.decideCase('case_obl_1')
    if (outcome?.finalVerdict !== 'EXECUTE' || outcome.chosenChannel === undefined) return

    const enqueued = await handle.db.select().from(actions)
    expect(enqueued[0]?.amountPaise).toBe(2_000_000)
  })

  it('runs decision and execution end to end and records the contact once', async () => {
    const sent: SendRequest[] = []
    const sender: MessageSender = {
      name: 'test',
      async send(request): Promise<SendResult> {
        sent.push(request)
        return {
          attempted: true,
          accepted: true,
          providerRef: 'msg_1',
          costPaise: paise(45),
          failureReason: undefined,
          retryable: false,
        }
      },
    }

    const payments: PaymentExecutor = {
      name: 'test',
      async charge() {
        return {
          attempted: true,
          succeeded: false,
          providerRef: 'pay_1',
          failure: undefined,
          costPaise: paise(0),
          retryable: false,
        }
      },
    }

    const executor = new Executor({
      db: handle.db,
      clock,
      ids: createIdFactory('exec'),
      rng: createRng(7),
      logger: silentLogger,
      outbox,
      authority,
      payments,
      senders: new Map([
        ['WHATSAPP', sender],
        ['SMS', sender],
        ['EMAIL', sender],
      ]),
      dryRun: false,
      isHalted: () => facts.killSwitchEngaged,
      stopContextFor: async (action, at) => {
        const view = await contexts.load(action.caseId)
        if (view === undefined) throw new Error('case vanished')
        void at
        return contexts.stopContext(view, action.type, paise(9_000))
      },
      payloadFor: async (action) => {
        const view = await contexts.load(action.caseId)
        if (view === undefined) return undefined
        const rendered = templates.render(action.type, view.customer.languagePref, {
          amountPaise: view.outstandingPaise,
          merchantName: 'Acme',
          link: `https://pay.example/${view.row.id}`,
          dueAt: view.row.dueAt,
          extensionDays: authority.extension.max_days,
        })
        return { recipientRef: view.customer.externalRef, body: rendered.body }
      },
    })

    await orchestrator.decideCase('case_obl_1')
    const drained = await executor.drain(AT)

    expect(drained.examined).toBeGreaterThan(0)
    const view = await contexts.load('case_obl_1')
    expect(view).toBeDefined()

    if (sent.length > 0) {
      expect(view?.row.touchCount).toBe(sent.length)
      expect(sent[0]?.body).toContain('₹')
    }
  })

  it('halts execution entirely when the kill switch is thrown mid-run', async () => {
    await orchestrator.decideCase('case_obl_1')
    facts = { ...facts, killSwitchEngaged: true }

    const executor = new Executor({
      db: handle.db,
      clock,
      ids: createIdFactory('exec'),
      rng: createRng(7),
      logger: silentLogger,
      outbox,
      authority,
      payments: {
        name: 'unused',
        async charge() {
          throw new Error('should never be called')
        },
      },
      senders: new Map(),
      dryRun: false,
      isHalted: () => facts.killSwitchEngaged,
      stopContextFor: async (action) => {
        const view = await contexts.load(action.caseId)
        if (view === undefined) throw new Error('case vanished')
        return contexts.stopContext(view, action.type, paise(9_000))
      },
      payloadFor: async () => undefined,
    })

    expect((await executor.drain(AT)).haltedByKillSwitch).toBe(true)
  })
})

describe('ContextBuilder', () => {
  let handle: DatabaseHandle
  let contexts: ContextBuilder

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle)
    await seedCase(handle, { at: AT - 86_400_000, amountPaise: 750_000 })

    const clock = new VirtualClock({ start: AT })
    const ids = createIdFactory('ctx')
    contexts = new ContextBuilder(handle.db, clock, new LedgerRepository(handle.db, ids), () => ({
      bankHolidays: new Set(),
      pausedCohorts: new Set(['upi|HDFC']),
      killSwitchEngaged: false,
      merchantPaused: false,
      isFestival: () => false,
    }))
  })

  afterEach(() => handle.close())

  it('derives outstanding from the ledger rather than the case row', async () => {
    const view = await contexts.load('case_obl_1')
    expect(view?.outstandingPaise).toBe(750_000)
    expect(view?.billedPaise).toBe(750_000)
  })

  it('reads the diagnosis to pick the failure class', async () => {
    expect((await contexts.load('case_obl_1'))?.failureClass).toBe('FUNDS_TIMING')
  })

  it('marks the cohort as paused when the world says so', async () => {
    const view = await contexts.load('case_obl_1')
    expect(view?.cohortPaused).toBe(true)
    if (view !== undefined) {
      expect(contexts.stopContext(view, 'RETRY_CHARGE', paise(1)).cohortPaused).toBe(true)
    }
  })

  it('loads consent for every channel it was captured on', async () => {
    const view = await contexts.load('case_obl_1')
    expect(view?.consents.WHATSAPP?.granted).toBe(true)
    expect(view?.consents.SMS?.granted).toBe(true)
  })

  it('returns nothing for a case that does not exist', async () => {
    expect(await contexts.load('case_nope')).toBeUndefined()
  })
})
