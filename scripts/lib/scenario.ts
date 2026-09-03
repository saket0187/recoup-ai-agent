import { existsSync, readFileSync } from 'node:fs'

import { migrate } from 'drizzle-orm/libsql/migrator'

import { VirtualClock } from '../../src/core/clock'
import { loadCosts, type AuthorityConfig, type CostsConfig } from '../../src/core/config-files'
import { createIdFactory } from '../../src/core/identifiers'
import { createLogger } from '../../src/core/logger'
import type { Paise } from '../../src/core/money'
import { createRng } from '../../src/core/seeded-random'
import { ALL_FEATURES, type EngineFeatures } from '../../src/decision/engine'
import { createDatabase, type DatabaseHandle } from '../../src/db/client'
import { consentRecords, customers, merchants } from '../../src/db/schema'
import type { Channel } from '../../src/domain/enums'
import { signPayload } from '../../src/providers/gateway/adapter'
import type { GatewayEvent } from '../../src/providers/gateway/webhook-schema'
import { channelCostsOf, composeAgent, type Agent } from '../../src/runtime/compose'
import type { CohortHealth } from '../../src/signal/degradation'
import type { DegradationDetector } from '../../src/signal/degradation'
import { SimulatedMessageSender, SimulatedPaymentExecutor } from '../../src/sim/adapters'
import {
  generatePopulation,
  summarisePopulation,
  type PopulationSummary,
} from '../../src/sim/population'
import { Simulator, type SimulationStats } from '../../src/sim/simulator'
import { loadWorldTimeline, type WorldTimeline } from '../../src/sim/world'
import type { InboundStats } from '../../src/inbound/agent'
import { parseUpliftModel, type UpliftModel } from '../../src/uplift/model'

const HOUR = 3_600_000
const WEBHOOK_SECRET = 'scenario_only_not_a_real_secret'
export const MERCHANT_ID = 'merch_demo'
const MERCHANT_NAME = 'Demo Merchant'

export interface ScenarioOptions {
  readonly seed: number
  readonly accounts: number
  readonly trafficPerHour: number
  readonly features?: EngineFeatures
  readonly label?: string
  readonly upliftModelPath?: string | null
  readonly annoyanceScale?: number
  readonly dbPath?: string
}

export interface ScenarioResult {
  readonly handle: DatabaseHandle
  readonly authority: AuthorityConfig
  readonly timeline: WorldTimeline
  readonly population: PopulationSummary
  readonly simulation: SimulationStats
  readonly incidents: { at: number; health: CohortHealth; snapshot: readonly CohortHealth[] }[]
  readonly receipts: { accepted: number; duplicate: number; rejected: number; deadLettered: number }
  readonly backgroundAttempts: number
  readonly banditArms: number
  readonly attribution: { credited: number; expired: number; pending: number }
  readonly inbound: InboundStats
  readonly promisesBroken: number
  readonly gating: { reviewerBlocked: number; allocationDeferred: number; scheduled: number }
  readonly elapsedMs: number
  readonly upliftModel: UpliftModel | undefined
}

function scaleAnnoyance(costs: CostsConfig, scale: number): CostsConfig {
  if (scale === 1) return costs
  const channels = Object.fromEntries(
    Object.entries(costs.channels).map(([channel, entry]) => [
      channel,
      { ...entry, annoyance_paise: Math.round((entry?.annoyance_paise ?? 0) * scale) },
    ]),
  ) as CostsConfig['channels']
  return { ...costs, channels }
}

function loadUpliftModel(path: string | null | undefined): UpliftModel | undefined {
  if (path === null) return undefined
  const resolved = path ?? './fixtures/uplift-model.json'
  if (!existsSync(resolved)) return undefined
  return parseUpliftModel(JSON.parse(readFileSync(resolved, 'utf8')))
}

export async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const upliftModel = loadUpliftModel(options.upliftModelPath)
  const costs = scaleAnnoyance(loadCosts(), options.annoyanceScale ?? 1)
  const timeline = loadWorldTimeline()

  const rng = createRng(options.seed)
  const ids = createIdFactory(`scenario-${options.seed}`)
  const clock = new VirtualClock({ start: timeline.startAt })
  const logger = createLogger({ level: 'error', clock })

  const handle = await createDatabase(options.dbPath ?? ':memory:')
  await migrate(handle.db, { migrationsFolder: './drizzle' })

  const accounts = generatePopulation(rng.derive('population'), ids, {
    merchantId: MERCHANT_ID,
    count: options.accounts,
    startAt: timeline.startAt,
    durationDays: timeline.durationDays,
  })

  await handle.db.insert(merchants).values({
    id: MERCHANT_ID,
    name: MERCHANT_NAME,
    timezone: 'Asia/Kolkata',
    marginRateBp: costs.margin_rate_bp,
    paused: false,
    createdAt: timeline.startAt,
  })

  for (let i = 0; i < accounts.length; i += 400) {
    const batch = accounts.slice(i, i + 400)
    await handle.db.insert(customers).values(
      batch.map((account) => ({
        id: account.id,
        merchantId: MERCHANT_ID,
        externalRef: account.externalRef,
        portfolio: account.portfolio,
        languagePref: account.languagePref,
        timezone: account.timezone,
        mandateCapPaise: account.mandateCapPaise,
        priorBillsSettled: account.priorBillsSettled,
        priorBillsPaid: account.priorBillsPaid,
        createdAt: timeline.startAt,
      })),
    )
    await handle.db.insert(consentRecords).values(
      batch.flatMap((account) =>
        account.consents.map((consent) => ({
          id: ids.next('consent'),
          customerId: account.id,
          channel: consent.channel,
          granted: consent.granted,
          dnd: consent.dnd,
          purpose: consent.purpose,
          source: consent.source,
          capturedAt: timeline.startAt,
        })),
      ),
    )
  }

  const receipts = { accepted: 0, duplicate: 0, rejected: 0, deadLettered: 0 }
  const incidents: { at: number; health: CohortHealth; snapshot: readonly CohortHealth[] }[] = []
  let backgroundAttempts = 0

  const runtime: { agent?: Agent } = {}

  const simulator = new Simulator({
    merchantId: MERCHANT_ID,
    accounts,
    timeline,
    clock,
    rng: rng.derive('simulator'),
    ids,
    sink: {
      async deliver(event: GatewayEvent): Promise<void> {
        const composed = runtime.agent
        if (composed === undefined) throw new Error('event arrived before composition')
        const rawBody = JSON.stringify(event)
        const outcome = await composed.ingest({
          eventId: ids.next('evt'),
          rawBody,
          signature: signPayload(rawBody, WEBHOOK_SECRET),
        })

        if (outcome.status === 'ACCEPTED') receipts.accepted++
        else if (outcome.status === 'DUPLICATE') receipts.duplicate++
        else if (outcome.status === 'REJECTED') receipts.rejected++
        else receipts.deadLettered++
      },
    },
    ...(options.trafficPerHour > 0
      ? {
          backgroundTraffic: {
            attemptsPerHour: options.trafficPerHour,
            baseSuccessRate: 0.93,
            cohorts: [
              ['upi', 'HDFC', 26],
              ['upi', 'ICICI', 18],
              ['upi', 'SBI', 16],
              ['card', 'HDFC', 12],
              ['card', 'ICICI', 10],
              ['netbanking', 'SBI', 8],
              ['netbanking', 'AXIS', 6],
              ['netbanking', 'YES', 4],
            ] as const,
            onAttempt(attempt: {
              at: number
              method: Parameters<DegradationDetector['observe']>[1]
              issuer: string
              succeeded: boolean
              amountPaise: Paise
            }) {
              backgroundAttempts++
              runtime.agent?.detector.observe(
                attempt.at,
                attempt.method,
                attempt.issuer,
                attempt.succeeded,
                attempt.amountPaise,
              )
            },
          },
        }
      : {}),
  })

  const channelCosts = channelCostsOf(costs)
  const senders = new Map<Channel, SimulatedMessageSender>(
    (['SMS', 'WHATSAPP', 'EMAIL', 'VOICE'] as Channel[]).map((channel) => [
      channel,
      new SimulatedMessageSender(channel, simulator, channelCosts),
    ]),
  )

  runtime.agent = composeAgent({
    db: handle.db,
    clock,
    ids,
    rng,
    logger,
    seed: options.seed,
    merchantId: MERCHANT_ID,
    merchantName: MERCHANT_NAME,
    webhookSecret: WEBHOOK_SECRET,
    payments: new SimulatedPaymentExecutor(simulator),
    senders,
    dryRun: false,
    costs,
    bankHolidays: timeline.bankHolidays,
    isFestival: (at) =>
      timeline.events.some(
        (event) => event.kind === 'festival' && at >= event.startAt && at < event.endAt,
      ),
    features: options.features ?? ALL_FEATURES,
    ...(upliftModel === undefined ? {} : { upliftModel }),
  })
  const composed = runtime.agent

  let inboundTotals: InboundStats = {
    processed: 0,
    promisesRecorded: 0,
    disputesOpened: 0,
    optOuts: 0,
    escalated: 0,
    byIntent: {},
  }
  let promisesBroken = 0
  const gating = { reviewerBlocked: 0, allocationDeferred: 0, scheduled: 0 }

  for (let at = timeline.startAt + HOUR; at < timeline.endAt; at += HOUR) {
    const tickAt = at
    clock.schedule(
      tickAt,
      async () => {
        const stats = await composed.tick(tickAt)

        for (const health of stats.incidents) {
          incidents.push({ at: tickAt, health, snapshot: stats.snapshot })
        }

        promisesBroken += stats.promisesBroken
        gating.reviewerBlocked += stats.cycle.reviewerBlocked
        gating.allocationDeferred += stats.cycle.allocationDeferred
        gating.scheduled += stats.cycle.scheduled

        inboundTotals = {
          processed: inboundTotals.processed + stats.inbound.processed,
          promisesRecorded: inboundTotals.promisesRecorded + stats.inbound.promisesRecorded,
          disputesOpened: inboundTotals.disputesOpened + stats.inbound.disputesOpened,
          optOuts: inboundTotals.optOuts + stats.inbound.optOuts,
          escalated: inboundTotals.escalated + stats.inbound.escalated,
          byIntent: Object.entries(stats.inbound.byIntent).reduce<InboundStats['byIntent']>(
            (merged, [intent, count]) => ({
              ...merged,
              [intent]: (merged[intent as keyof typeof merged] ?? 0) + (count ?? 0),
            }),
            inboundTotals.byIntent,
          ),
        }
      },
      'engine-tick',
    )
  }

  const startedAt = process.hrtime.bigint()
  const simulation = await simulator.run()
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

  return {
    handle,
    authority: composed.authority,
    timeline,
    population: summarisePopulation(accounts),
    simulation,
    incidents,
    receipts,
    backgroundAttempts,
    banditArms: composed.bandit.size(),
    attribution: composed.attribution.stats(),
    inbound: inboundTotals,
    promisesBroken,
    gating,
    elapsedMs,
    upliftModel,
  }
}
