import { describe, expect, it } from 'vitest'

import { VirtualClock } from '../src/core/clock'
import { fromIst } from '../src/core/calendar'
import { createIdFactory } from '../src/core/identifiers'
import { paise } from '../src/core/money'
import { createRng } from '../src/core/seeded-random'
import { detectTdsShortfall } from '../src/ledger/tds'
import { gatewayEventSchema } from '../src/providers/gateway/webhook-schema'
import { generatePopulation, type SimAccount } from '../src/sim/population'
import { CollectingSink, Simulator, type SimulationStats } from '../src/sim/simulator'
import { loadWorldTimeline, parseWorldTimeline } from '../src/sim/world'

const TIMELINE = loadWorldTimeline()

interface Harness {
  simulator: Simulator
  sink: CollectingSink
  clock: VirtualClock
  accounts: SimAccount[]
}

function harness(count: number, seed = 42, timeline = TIMELINE): Harness {
  const rng = createRng(seed)
  const ids = createIdFactory(`sim-${seed}`)
  const clock = new VirtualClock({ start: timeline.startAt })
  const sink = new CollectingSink()
  const accounts = generatePopulation(rng.derive('population'), ids, {
    merchantId: 'merch_1',
    count,
    startAt: timeline.startAt,
    durationDays: timeline.durationDays,
  })

  return {
    accounts,
    clock,
    sink,
    simulator: new Simulator({
      merchantId: 'merch_1',
      accounts,
      timeline,
      clock,
      rng: rng.derive('simulator'),
      ids,
      sink,
    }),
  }
}

describe('Simulator', () => {
  it('replays a 45-day, 2000-account world on the virtual clock', async () => {
    const { simulator, clock } = harness(2_000)
    const stats = await simulator.run()

    expect(stats.obligationsDue).toBeGreaterThan(2_000)
    expect(stats.chargeAttempts + stats.checkoutsAbandoned).toBe(stats.obligationsDue)
    expect(stats.chargeSuccesses + stats.chargeFailures).toBe(stats.chargeAttempts)
    expect(clock.now()).toBe(TIMELINE.endAt)
  })

  it('abandons some checkouts before any charge is attempted', async () => {
    const { simulator, sink } = harness(2_000)
    const stats = await simulator.run()

    expect(stats.checkoutsAbandoned).toBeGreaterThan(0)
    expect(sink.ofType('order.abandoned').length).toBe(stats.checkoutsAbandoned)
  })

  it('reports an abandoned order as unpaid, with the amount still owed', async () => {
    const { simulator, sink } = harness(600)
    await simulator.run()

    const [abandoned] = sink.ofType('order.abandoned')
    const entity = abandoned?.payload.order?.entity
    expect(entity?.amount_paid).toBe(0)
    expect(entity?.amount).toBeGreaterThan(0)
    expect(entity?.notes.obligation_id).toBeDefined()
  })

  it('still attempts an explicit retry against an abandoned order', async () => {
    const { simulator, accounts } = harness(300)
    await simulator.run()

    const checkout = accounts.find((account) => account.portfolio === 'one_time_checkout')
    const obligation = checkout?.obligations[0]
    expect(obligation).toBeDefined()

    const result = await simulator.retry(obligation?.id ?? '', TIMELINE.endAt)
    expect(typeof result.succeeded).toBe('boolean')
  })

  it('produces both successes and failures rather than a degenerate world', async () => {
    const stats = await harness(2_000).simulator.run()
    expect(stats.chargeSuccesses).toBeGreaterThan(100)
    expect(stats.chargeFailures).toBeGreaterThan(100)
  })

  it('replays identically for the same seed', async () => {
    const first = await harness(500, 7).simulator.run()
    const second = await harness(500, 7).simulator.run()
    expect(first).toEqual(second)
  })

  it('produces a different world for a different seed', async () => {
    const first = await harness(500, 7).simulator.run()
    const second = await harness(500, 8).simulator.run()
    expect(first).not.toEqual(second)
  })

  it('emits only schema-valid gateway events', async () => {
    const { simulator, sink } = harness(400)
    await simulator.run()

    expect(sink.events.length).toBeGreaterThan(0)
    for (const { event } of sink.events) {
      expect(() => gatewayEventSchema.parse(event)).not.toThrow()
    }
  })

  it('timestamps events in seconds, as the wire format requires', async () => {
    const { simulator, sink } = harness(200)
    await simulator.run()

    for (const { event, at } of sink.events) {
      expect(event.created_at).toBe(Math.floor(at / 1000))
    }
  })

  it('carries the obligation reference in notes so events can be correlated', async () => {
    const { simulator, sink } = harness(300)
    await simulator.run()

    const failures = sink.ofType('payment.failed')
    expect(failures.length).toBeGreaterThan(0)
    for (const event of failures) {
      expect(event.payload.payment?.entity.notes.obligation_id).toMatch(/^obl_/)
    }
  })

  it('emits a started and a resolved event for every downtime window', async () => {
    const { simulator, sink } = harness(100)
    const stats = await simulator.run()

    expect(sink.ofType('payment.downtime.started')).toHaveLength(stats.downtimeWindows)
    expect(sink.ofType('payment.downtime.resolved')).toHaveLength(stats.downtimeWindows)
    expect(stats.downtimeWindows).toBeGreaterThan(0)
  })

  it('scopes the outage event to the affected method and issuer', async () => {
    const { simulator, sink } = harness(100)
    await simulator.run()

    const started = sink
      .ofType('payment.downtime.started')
      .map((event) => event.payload['payment.downtime']?.entity)

    expect(
      started.some((entity) => entity?.method === 'upi' && entity.instrument.issuer === 'HDFC'),
    ).toBe(true)
  })
})

describe('failure attribution against known ground truth', () => {
  it('blames the bank, never the customer, during an outage on that cohort', async () => {
    const { simulator, sink, accounts } = harness(600)
    const duringOutage = fromIst(2026, 9, 3, 15, 0)

    const affected = accounts.filter(
      (account) =>
        account.latent.instrument.method === 'upi' && account.latent.instrument.issuer === 'HDFC',
    )
    expect(affected.length).toBeGreaterThan(0)

    for (const account of affected) {
      const obligation = account.obligations[0]
      if (obligation === undefined) continue
      const result = await simulator.retry(obligation.id, duringOutage)
      expect(result.succeeded).toBe(false)
      expect(result.cause).toBe('DOWNTIME')
    }

    const sources = sink
      .ofType('payment.failed')
      .map((event) => event.payload.payment?.entity.error_source)

    expect(sources.length).toBeGreaterThan(0)
    expect(sources).not.toContain('customer')
    for (const source of sources) {
      expect(['bank', 'gateway']).toContain(source)
    }
  })

  it('leaves an unaffected cohort untouched during the same outage', async () => {
    const { simulator, accounts } = harness(600)
    const duringOutage = fromIst(2026, 9, 3, 15, 0)

    const unaffected = accounts.find(
      (account) =>
        account.latent.instrument.method === 'card' && account.latent.instrument.issuer !== 'HDFC',
    )
    const obligation = unaffected?.obligations[0]
    expect(obligation).toBeDefined()

    if (obligation !== undefined) {
      const result = await simulator.retry(obligation.id, duringOutage)
      expect(result.cause).not.toBe('DOWNTIME')
    }
  })

  it('attributes the bad deploy to the business, not the customer', async () => {
    const { simulator, sink, accounts } = harness(200)
    const duringDefect = fromIst(2026, 9, 5, 11, 20)

    for (const account of accounts.slice(0, 25)) {
      const obligation = account.obligations[0]
      if (obligation === undefined) continue
      const result = await simulator.retry(obligation.id, duringDefect)
      expect(result.cause).toBe('MERCHANT_DEFECT')
    }

    const failures = sink.ofType('payment.failed')
    expect(failures.length).toBeGreaterThan(0)
    for (const event of failures) {
      expect(event.payload.payment?.entity.error_source).toBe('business')
      expect(event.payload.payment?.entity.error_reason).toBe('input_validation_failed')
    }
  })

  it('recovers once the defect window closes', async () => {
    const { simulator, accounts } = harness(200)
    const afterDefect = fromIst(2026, 9, 5, 12, 0)

    const obligation = accounts[0]?.obligations[0]
    expect(obligation).toBeDefined()

    if (obligation !== undefined) {
      const result = await simulator.retry(obligation.id, afterDefect)
      expect(result.cause).not.toBe('MERCHANT_DEFECT')
    }
  })

  it('never blames an absent customer for an auto-debit failure', async () => {
    const { simulator, sink } = harness(3_000)
    await simulator.run()

    const autoDebitFailures = sink
      .ofType('payment.failed')
      .map((event) => event.payload.payment?.entity)
      .filter((entity) => entity?.method === 'nach' || entity?.method === 'emandate')

    expect(autoDebitFailures.length).toBeGreaterThan(0)

    for (const entity of autoDebitFailures) {
      expect(entity?.error_step).not.toBe('payment_authentication')
      expect(entity?.error_reason).not.toBe('invalid_otp')
      expect(entity?.error_reason).not.toBe('payment_cancelled')
      expect(entity?.error_reason).not.toBe('payment_timeout')
    }
  })

  it('never reports a card-specific failure on a non-card rail', async () => {
    const { simulator, sink } = harness(3_000)
    await simulator.run()

    for (const event of sink.ofType('payment.failed')) {
      const entity = event.payload.payment?.entity
      if (entity === undefined || entity.method === 'card') continue
      expect(entity.error_reason).not.toMatch(/card/)
    }
  })

  it('spreads failures across several causes', async () => {
    const stats = await harness(2_000).simulator.run()
    const observed = Object.entries(stats.failuresByCause).filter(([, count]) => count > 0)
    expect(observed.length).toBeGreaterThanOrEqual(5)
  })
})

describe('subscription dunning', () => {
  it('halts a subscription after three failed attempts', async () => {
    const { simulator, sink, accounts } = harness(400)
    const at = fromIst(2026, 9, 20, 12)

    const account = accounts.find(
      (candidate) =>
        candidate.portfolio === 'd2c_subscription' &&
        candidate.latent.instrument.mandateStatus === 'REVOKED',
    )
    const obligation = account?.obligations[0]
    expect(obligation).toBeDefined()

    if (obligation !== undefined) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await simulator.retry(obligation.id, at + attempt * 3_600_000)
      }
    }

    expect(sink.ofType('subscription.halted').length).toBeGreaterThan(0)
  })

  it('stops attempting once halted', async () => {
    const { simulator, accounts } = harness(400)
    const at = fromIst(2026, 9, 20, 12)

    const account = accounts.find(
      (candidate) =>
        candidate.portfolio === 'd2c_subscription' &&
        candidate.latent.instrument.mandateStatus === 'REVOKED',
    )
    const obligation = account?.obligations[0]
    if (obligation === undefined) return

    for (let attempt = 0; attempt < 3; attempt++) {
      await simulator.retry(obligation.id, at + attempt * 3_600_000)
    }

    const afterHalt = await simulator.retry(obligation.id, at + 10 * 3_600_000)
    expect(afterHalt.successProbability).toBe(0)
    expect(afterHalt.cause).toBeNull()
  })
})

describe('B2B tax deducted at source', () => {
  it('short-pays invoices, and the shortfall is recognisable as TDS', async () => {
    const { simulator, sink } = harness(2_000)
    const stats = await simulator.run()

    const partials = sink.ofType('invoice.partially_paid')
    expect(stats.partialPayments).toBeGreaterThan(0)
    expect(partials.length).toBe(stats.partialPayments)

    for (const event of partials) {
      const entity = event.payload.invoice?.entity
      expect(entity).toBeDefined()
      if (entity === undefined) continue

      const match = detectTdsShortfall(paise(entity.amount), paise(entity.amount_paid), {
        gstRatesPct: [0],
      })
      expect(match).not.toBeNull()
      expect([1, 2, 10]).toContain(match?.ratePct)
    }
  })

  it('settles consumer payments in full, with no phantom shortfall', async () => {
    const { simulator, sink } = harness(1_000)
    await simulator.run()

    for (const event of sink.ofType('payment.captured')) {
      expect(event.payload.payment?.entity.captured).toBe(true)
      expect(event.payload.payment?.entity.error_code).toBeNull()
    }
  })
})

describe('actions', () => {
  it('records a touch and accrues annoyance', async () => {
    const { simulator, accounts } = harness(50)
    const account = accounts[0]
    const obligation = account?.obligations[0]
    expect(obligation).toBeDefined()
    if (obligation === undefined || account === undefined) return

    await simulator.applyAction(obligation.id, 'SEND_NUDGE', 'WHATSAPP', fromIst(2026, 9, 10, 12))
    expect(account.dynamic.annoyanceAccrued).toBeGreaterThan(0)
    expect(account.dynamic.lastContactAt).toBe(fromIst(2026, 9, 10, 12))
  })

  it('rejects an unknown obligation', async () => {
    const { simulator } = harness(10)
    await expect(simulator.retry('obl_nope', TIMELINE.startAt)).rejects.toThrow(
      /Unknown obligation/,
    )
  })

  it('reduces the outstanding balance when an action lands a payment', async () => {
    const { simulator, accounts } = harness(300)
    const at = fromIst(2026, 9, 2, 12)

    for (const account of accounts) {
      const obligation = account.obligations[0]
      if (obligation === undefined) continue
      const before = simulator.outstandingOf(obligation.id)
      const outcome = await simulator.applyAction(
        obligation.id,
        'SEND_PAYMENT_LINK',
        'WHATSAPP',
        at,
      )
      if (outcome.paid) {
        expect(simulator.outstandingOf(obligation.id)).toBeLessThan(before)
        return
      }
    }
  })
})

describe('an empty world', () => {
  it('runs to completion with no events scheduled', async () => {
    const empty = parseWorldTimeline(`
timezone: Asia/Kolkata
start_date: "2026-09-01"
duration_days: 5
events: []
`)
    const stats: SimulationStats = await harness(20, 1, empty).simulator.run()
    expect(stats.downtimeWindows).toBe(0)
    expect(stats.chargeAttempts).toBeGreaterThanOrEqual(0)
  })
})
