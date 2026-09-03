import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { loadAuthority } from '../src/core/config-files'
import { VirtualClock } from '../src/core/clock'
import { createIdFactory } from '../src/core/identifiers'
import { silentLogger } from '../src/core/logger'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import type { DatabaseHandle } from '../src/db/client'
import { actions, contactEvents, riskCases } from '../src/db/schema'
import { DryRunViolationError, Executor } from '../src/execution/executor'
import { Outbox } from '../src/execution/outbox'
import type { StopContext } from '../src/policy/stop-gate'
import type {
  ChargeRequest,
  ChargeResult,
  MessageSender,
  PaymentExecutor,
  SendRequest,
  SendResult,
} from '../src/providers/port'
import { createTestDatabase, seedCase, seedDecision, seedMerchant } from './helpers/database'

const authority = loadAuthority()
const AT = 1_760_000_000_000

class RecordingPayments implements PaymentExecutor {
  readonly name = 'recording'
  readonly calls: ChargeRequest[] = []
  private readonly result: Partial<ChargeResult>

  constructor(result: Partial<ChargeResult> = {}) {
    this.result = result
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.calls.push(request)
    return {
      attempted: !request.dryRun,
      succeeded: true,
      providerRef: 'pay_x',
      failure: undefined,
      costPaise: paise(0),
      retryable: false,
      ...this.result,
    }
  }
}

class RecordingSender implements MessageSender {
  readonly name = 'recording'
  readonly calls: SendRequest[] = []
  private readonly result: Partial<SendResult>

  constructor(result: Partial<SendResult> = {}) {
    this.result = result
  }

  async send(request: SendRequest): Promise<SendResult> {
    this.calls.push(request)
    return {
      attempted: !request.dryRun,
      accepted: true,
      providerRef: 'msg_x',
      costPaise: paise(45),
      failureReason: undefined,
      retryable: false,
      ...this.result,
    }
  }
}

function stopContext(overrides: Partial<StopContext> = {}): StopContext {
  return {
    at: AT,
    action: 'SEND_NUDGE',
    outstandingPaise: paise(500_000),
    originalAmountPaise: paise(500_000),
    disputeOpen: false,
    invoiceDisputed: false,
    optedOut: false,
    wrongPerson: false,
    deceased: false,
    distressSignalled: false,
    abuseSignalled: false,
    retriesExcludingInfra: 0,
    touchCount: 0,
    bestRemainingEvPaise: paise(9_000),
    mandateDead: false,
    riskFlagged: false,
    cohortPaused: false,
    killSwitchEngaged: false,
    merchantPaused: false,
    hasActivePromise: false,
    promiseDueAt: undefined,
    economicStopsApply: true,
    caseAgeDays: 2,
    ...overrides,
  }
}

describe('Outbox', () => {
  let handle: DatabaseHandle
  let outbox: Outbox

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle)
    await seedCase(handle)
    await seedDecision(handle)
    outbox = new Outbox(handle.db, new VirtualClock({ start: AT }), createIdFactory('outbox'))
  })

  afterEach(() => handle.close())

  const enqueue = (key: string, scheduledFor = AT) =>
    outbox.enqueue({
      decisionId: 'decision_1',
      caseId: 'case_obl_1',
      type: 'SEND_NUDGE',
      channel: 'WHATSAPP',
      templateId: 'NUDGE',
      language: 'en',
      amountPaise: paise(500_000),
      scheduledFor,
      merchantId: 'merch_test',
      idempotencyKey: key,
      bestRemainingEvPaise: 10_000,
      dryRun: true,
    })

  it('refuses to enqueue the same idempotency key twice', async () => {
    const first = await enqueue('key_1')
    const second = await enqueue('key_1')

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.actionId).toBe(first.actionId)
    expect(await handle.db.select().from(actions)).toHaveLength(1)
  })

  it('only returns actions that are due', async () => {
    await enqueue('key_now', AT)
    await enqueue('key_later', AT + 86_400_000)

    expect(await outbox.due(AT)).toHaveLength(1)
    expect(await outbox.due(AT + 86_400_000)).toHaveLength(2)
  })

  it('lets exactly one claimant take an action', async () => {
    const { actionId } = await enqueue('key_1')
    expect(await outbox.claim(actionId)).toBe(true)
    expect(await outbox.claim(actionId)).toBe(false)
  })

  it('cancels everything still pending for a case', async () => {
    await enqueue('key_1')
    await enqueue('key_2', AT + 1000)
    const cancelled = await outbox.cancelPendingForCase('case_obl_1', 'STOP_PAID')

    expect(cancelled).toBe(2)
    expect(await outbox.due(AT + 10_000)).toHaveLength(0)
  })
})

describe('Executor', () => {
  let handle: DatabaseHandle
  let outbox: Outbox
  let clock: VirtualClock

  beforeEach(async () => {
    handle = await createTestDatabase()
    await seedMerchant(handle)
    await seedCase(handle)
    await seedDecision(handle)
    clock = new VirtualClock({ start: AT })
    outbox = new Outbox(handle.db, clock, createIdFactory('outbox'))
  })

  afterEach(() => handle.close())

  function build(options: {
    payments?: PaymentExecutor
    sender?: MessageSender
    dryRun?: boolean
    halted?: boolean
    stop?: Partial<StopContext>
    maxAttempts?: number
  }): Executor {
    const sender = options.sender ?? new RecordingSender()
    return new Executor({
      db: handle.db,
      clock,
      ids: createIdFactory('exec'),
      rng: createRng(42),
      logger: silentLogger,
      outbox,
      authority,
      payments: options.payments ?? new RecordingPayments(),
      senders: new Map([['WHATSAPP', sender]]),
      dryRun: options.dryRun ?? false,
      isHalted: () => options.halted ?? false,
      stopContextFor: async (action) => stopContext({ action: action.type, ...options.stop }),
      payloadFor: async () => ({ recipientRef: 'cust_1', body: 'your payment did not go through' }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    })
  }

  const enqueueNudge = (key = 'key_1') =>
    outbox.enqueue({
      decisionId: 'decision_1',
      caseId: 'case_obl_1',
      type: 'SEND_NUDGE',
      channel: 'WHATSAPP',
      templateId: 'NUDGE',
      language: 'en',
      amountPaise: paise(500_000),
      scheduledFor: AT,
      merchantId: 'merch_test',
      idempotencyKey: key,
      bestRemainingEvPaise: 10_000,
      dryRun: false,
    })

  it('sends a due action and records the contact', async () => {
    await enqueueNudge()
    const sender = new RecordingSender()
    const stats = await build({ sender }).drain(AT)

    expect(stats.sent).toBe(1)
    expect(sender.calls).toHaveLength(1)

    const contacts = await handle.db.select().from(contactEvents)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]?.direction).toBe('OUTBOUND')

    const cases = await handle.db.select().from(riskCases)
    expect(cases[0]?.touchCount).toBe(1)
  })

  it('halts entirely when the kill switch is engaged and leaves work queued', async () => {
    await enqueueNudge()
    const sender = new RecordingSender()
    const stats = await build({ sender, halted: true }).drain(AT)

    expect(stats.haltedByKillSwitch).toBe(true)
    expect(sender.calls).toHaveLength(0)
    expect(await outbox.due(AT)).toHaveLength(1)
  })

  it('re-runs the stop gate at execute time and suppresses when state has changed', async () => {
    await enqueueNudge('key_1')
    await outbox.enqueue({
      decisionId: 'decision_1',
      caseId: 'case_obl_1',
      type: 'SEND_NUDGE',
      channel: 'WHATSAPP',
      templateId: 'NUDGE',
      language: 'en',
      amountPaise: paise(500_000),
      scheduledFor: AT + 1000,
      merchantId: 'merch_test',
      idempotencyKey: 'key_2',
      bestRemainingEvPaise: 10_000,
      dryRun: false,
    })

    const sender = new RecordingSender()
    const stats = await build({ sender, stop: { optedOut: true } }).drain(AT)

    expect(stats.suppressed).toBe(1)
    expect(sender.calls).toHaveLength(0)

    const rows = await handle.db.select().from(actions)
    expect(rows.find((r) => r.idempotencyKey === 'key_1')?.status).toBe('SUPPRESSED')
    expect(rows.find((r) => r.idempotencyKey === 'key_2')?.status).toBe('CANCELLED')

    const cases = await handle.db.select().from(riskCases)
    expect(cases[0]?.state).toBe('STOPPED')
    expect(cases[0]?.stopReason).toBe('STOP_OPT_OUT')
  })

  it('reschedules rather than sending when the stop gate defers at execute time', async () => {
    await enqueueNudge()
    const sender = new RecordingSender()
    const stats = await build({
      sender,
      stop: { hasActivePromise: true, promiseDueAt: AT + 3 * 86_400_000 },
    }).drain(AT)

    expect(stats.deferred).toBe(1)
    expect(sender.calls).toHaveLength(0)

    const rows = await handle.db.select().from(actions)
    expect(rows[0]?.status).toBe('SCHEDULED')
    expect(rows[0]?.scheduledFor).toBeGreaterThan(AT)
  })

  it('records no contact and no touch in dry run, so caps and metrics stay honest', async () => {
    await enqueueNudge()
    const sender = new RecordingSender({ attempted: false, accepted: false })
    const stats = await build({ sender, dryRun: true }).drain(AT)

    expect(stats.sent).toBe(0)
    expect(stats.suppressed).toBe(1)
    expect(sender.calls[0]?.dryRun).toBe(true)
    expect(await handle.db.select().from(contactEvents)).toHaveLength(0)

    const cases = await handle.db.select().from(riskCases)
    expect(cases[0]?.touchCount).toBe(0)
  })

  it('halts loudly if a provider performs a real send during a dry run', async () => {
    await enqueueNudge()
    const rogue = new RecordingSender({ attempted: true })
    await expect(build({ sender: rogue, dryRun: true }).drain(AT)).rejects.toThrow(
      DryRunViolationError,
    )
  })

  it('retries a retryable failure with backoff before giving up', async () => {
    await enqueueNudge()
    const failing = new RecordingSender({
      accepted: false,
      retryable: true,
      failureReason: 'timeout',
    })
    const stats = await build({ sender: failing, maxAttempts: 3 }).drain(AT)

    expect(stats.retried).toBe(1)
    const rows = await handle.db.select().from(actions)
    expect(rows[0]?.status).toBe('SCHEDULED')
    expect(rows[0]?.attempts).toBe(1)
    expect(rows[0]?.scheduledFor).toBeGreaterThan(AT)
  })

  it('dead-letters after the attempt budget rather than retrying forever', async () => {
    await enqueueNudge()
    const failing = new RecordingSender({
      accepted: false,
      retryable: true,
      failureReason: 'timeout',
    })
    const executor = build({ sender: failing, maxAttempts: 3 })

    let at = AT
    for (let i = 0; i < 5; i++) {
      const rows = await handle.db.select().from(actions).where(eq(actions.idempotencyKey, 'key_1'))
      at = Math.max(at, rows[0]?.scheduledFor ?? at)
      await executor.drain(at)
    }

    const rows = await handle.db.select().from(actions)
    expect(rows[0]?.status).toBe('DEAD_LETTER')
    expect(rows[0]?.attempts).toBe(3)
  })

  it('dead-letters when no sender is registered for the channel', async () => {
    await outbox.enqueue({
      decisionId: 'decision_1',
      caseId: 'case_obl_1',
      type: 'SEND_NUDGE',
      channel: 'VOICE',
      templateId: 'NUDGE',
      language: 'en',
      amountPaise: paise(500_000),
      scheduledFor: AT,
      merchantId: 'merch_test',
      idempotencyKey: 'key_voice',
      bestRemainingEvPaise: 10_000,
      dryRun: false,
    })

    const stats = await build({}).drain(AT)
    expect(stats.deadLettered).toBe(1)
  })

  it('dispatches a charge through the payment port, not a message sender', async () => {
    await outbox.enqueue({
      decisionId: 'decision_1',
      caseId: 'case_obl_1',
      type: 'RETRY_CHARGE',
      channel: undefined,
      templateId: undefined,
      language: undefined,
      amountPaise: paise(500_000),
      scheduledFor: AT,
      merchantId: 'merch_test',
      idempotencyKey: 'key_charge',
      bestRemainingEvPaise: 10_000,
      dryRun: false,
    })

    const payments = new RecordingPayments()
    const sender = new RecordingSender()
    const stats = await build({ payments, sender }).drain(AT)

    expect(stats.sent).toBe(1)
    expect(payments.calls).toHaveLength(1)
    expect(payments.calls[0]?.amountPaise).toBe(500_000)
    expect(sender.calls).toHaveLength(0)
    expect(await handle.db.select().from(contactEvents)).toHaveLength(0)
  })

  it('passes the same idempotency key to the provider that the outbox holds', async () => {
    await enqueueNudge('stable_key')
    const sender = new RecordingSender()
    await build({ sender }).drain(AT)
    expect(sender.calls[0]?.idempotencyKey).toBe('stable_key')
  })
})
