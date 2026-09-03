import { loadTemplates, type TemplateRegistry } from '../content/templates'
import type { Clock } from '../core/clock'
import {
  loadAuthority,
  loadCosts,
  loadCalendar,
  loadPolicy,
  type AuthorityConfig,
  type CostsConfig,
} from '../core/config-files'
import type { IdFactory } from '../core/identifiers'
import type { Logger } from '../core/logger'
import { paise, type Paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import { ThompsonBandit } from '../decision/bandit'
import { BanditStore } from '../decision/bandit-store'
import type { EngineFeatures } from '../decision/engine'
import { AttributionTracker } from '../decision/feedback'
import { AuditChain } from '../db/audit-chain'
import type { Database } from '../db/client'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { cohorts, merchants } from '../db/schema'
import type { Channel } from '../domain/enums'
import { ContextBuilder, type WorldFacts } from '../engine/context-builder'
import { Orchestrator, type CycleStats } from '../engine/orchestrator'
import { StratifiedAssigner } from '../experiment/arm'
import { Executor, type DrainStats } from '../execution/executor'
import { Outbox } from '../execution/outbox'
import { InboundAgent, type InboundStats } from '../inbound/agent'
import { LedgerRepository } from '../ledger/ledger'
import { PolicyEngine } from '../policy/engine'
import { GatewayWebhookSource } from '../providers/gateway/adapter'
import type { MessageSender, PaymentExecutor } from '../providers/port'
import { CaseProjector } from '../signal/case-projector'
import { DegradationDetector, type CohortHealth } from '../signal/degradation'
import { WebhookReceiver, type ReceiveOutcome, type ReceiveRequest } from '../signal/receiver'
import type { UpliftModel } from '../uplift/model'

const HOUR_MS = 3_600_000
const DETECTOR_WINDOW_MS = 60 * HOUR_MS
const DETECTOR_MIN_VOLUME = 30
const DETECTOR_RETENTION_MS = 3 * HOUR_MS
const TICK_LEASE_MS = 10 * 60_000
const BANDIT_RELOAD_TICKS = 24

export interface AgentPorts {
  readonly db: Database
  readonly clock: Clock
  readonly ids: IdFactory
  readonly rng: Rng
  readonly logger: Logger
  readonly seed: number
  readonly merchantId: string
  readonly merchantName: string
  readonly webhookSecret: string
  readonly payments: PaymentExecutor
  readonly senders: ReadonlyMap<Channel, MessageSender>
  readonly dryRun: boolean
  readonly costs?: CostsConfig
  readonly features?: EngineFeatures
  readonly upliftModel?: UpliftModel
  readonly bankHolidays?: ReadonlySet<string>
  readonly isFestival?: (at: number) => boolean
  readonly killSwitchEngaged?: () => boolean
  readonly leaseTicks?: boolean
}

export class TickBusyError extends Error {
  override readonly name = 'TickBusyError'
}

export interface TickStats {
  readonly cycle: CycleStats
  readonly drain: DrainStats
  readonly inbound: InboundStats
  readonly promisesBroken: number
  readonly incidents: readonly CohortHealth[]
  readonly snapshot: readonly CohortHealth[]
}

export interface Agent {
  restore(): Promise<number>
  ingest(request: ReceiveRequest): Promise<ReceiveOutcome>
  tick(at?: number): Promise<TickStats>
  readonly clock: Clock
  readonly detector: DegradationDetector
  readonly bandit: ThompsonBandit
  readonly attribution: AttributionTracker
  readonly contexts: ContextBuilder
  readonly orchestrator: Orchestrator
  readonly executor: Executor
  readonly inbound: InboundAgent
  readonly outbox: Outbox
  readonly facts: WorldFacts
  readonly authority: AuthorityConfig
  readonly costs: CostsConfig
  readonly templates: TemplateRegistry
}

export function composeAgent(ports: AgentPorts): Agent {
  const authority = loadAuthority()
  const costs = ports.costs ?? loadCosts()
  const policyConfig = loadPolicy()
  const templates = loadTemplates()

  const calendar =
    ports.bankHolidays === undefined || ports.isFestival === undefined ? loadCalendar() : undefined
  const bankHolidays = ports.bankHolidays ?? calendar?.bankHolidays ?? new Set<string>()
  const isFestival =
    ports.isFestival ?? ((at: number): boolean => calendar?.isFestival(at) === true)

  const pausedCohorts = new Set<string>()
  const facts: {
    -readonly [K in keyof WorldFacts]: WorldFacts[K]
  } = {
    bankHolidays,
    pausedCohorts,
    killSwitchEngaged: false,
    merchantPaused: false,
    isFestival,
  }

  const source = new GatewayWebhookSource(ports.webhookSecret)
  const receiver = new WebhookReceiver({
    db: ports.db,
    clock: ports.clock,
    ids: ports.ids,
    source,
    logger: ports.logger,
  })

  const ledger = new LedgerRepository(ports.db, ports.ids)
  const projector = new CaseProjector({
    db: ports.db,
    clock: ports.clock,
    ids: ports.ids,
    logger: ports.logger,
    merchantId: ports.merchantId,
    assigner: new StratifiedAssigner(`assignment-${ports.seed}`),
    policyVersion: policyConfig.policy_version,
  })

  const detector = new DegradationDetector({
    windowMs: DETECTOR_WINDOW_MS,
    minVolume: DETECTOR_MIN_VOLUME,
  })
  const contexts = new ContextBuilder(ports.db, ports.clock, ledger, () => facts)
  const outbox = new Outbox(ports.db, ports.clock, ports.ids)
  const audit = new AuditChain(ports.db, ports.clock, ports.ids)

  const bandit = new ThompsonBandit(ports.rng.derive('bandit'))
  const banditStore = new BanditStore(ports.db, ports.merchantId)
  let ticksSinceReload = 0
  const attribution = new AttributionTracker(
    bandit,
    authority.cadence.attribution_window_hours * HOUR_MS,
  )

  const inbound = new InboundAgent({
    db: ports.db,
    clock: ports.clock,
    ids: ports.ids,
    logger: ports.logger,
    authority,
  })

  const orchestrator = new Orchestrator({
    db: ports.db,
    clock: ports.clock,
    ids: ports.ids,
    rng: ports.rng.derive('decision'),
    logger: ports.logger,
    merchantId: ports.merchantId,
    merchantName: ports.merchantName,
    policy: new PolicyEngine(policyConfig, authority, bankHolidays),
    authority,
    costs,
    bandit,
    templates,
    contexts,
    audit,
    attribution,
    ...(ports.features === undefined ? {} : { features: ports.features }),
    ...(ports.upliftModel === undefined ? {} : { upliftModel: ports.upliftModel }),
    dryRun: ports.dryRun,
    enqueue: (request) => outbox.enqueue(request),
  })

  const executor = new Executor({
    db: ports.db,
    clock: ports.clock,
    ids: ports.ids,
    rng: ports.rng.derive('executor'),
    logger: ports.logger,
    outbox,
    authority,
    payments: ports.payments,
    senders: ports.senders,
    dryRun: ports.dryRun,
    isHalted: () => facts.killSwitchEngaged || facts.merchantPaused,
    stopContextFor: async (action) => {
      const view = await contexts.load(action.caseId)
      if (view === undefined) throw new Error(`case ${action.caseId} vanished before execution`)
      return contexts.stopContext(view, action.type, paise(action.bestRemainingEvPaise))
    },
    payloadFor: async (action) => {
      const view = await contexts.load(action.caseId)
      if (view === undefined) return undefined
      try {
        const rendered = templates.render(action.type, view.customer.languagePref, {
          amountPaise: view.outstandingPaise,
          merchantName: ports.merchantName,
          link: `https://pay.example/${view.row.id}`,
          dueAt: view.row.dueAt,
          extensionDays: authority.extension.max_days,
        })
        return { recipientRef: view.customer.externalRef, body: rendered.body }
      } catch {
        return undefined
      }
    },
  })

  async function ingest(request: ReceiveRequest): Promise<ReceiveOutcome> {
    const outcome = await receiver.receive(request)
    if (outcome.status !== 'ACCEPTED') return outcome

    for (const signal of outcome.signals) {
      if (signal.method !== undefined && signal.issuer !== undefined) {
        detector.observe(
          signal.occurredAt,
          signal.method,
          signal.issuer,
          signal.kind === 'PAYMENT_SUCCEEDED',
          signal.amountPaise ?? paise(0),
        )
      }
      await projector.project(signal)
    }

    return outcome
  }

  async function persistCohorts(at: number, snapshot: readonly CohortHealth[]): Promise<void> {
    if (snapshot.length === 0) return
    await ports.db
      .insert(cohorts)
      .values(
        snapshot.map((health) => ({
          id: ports.ids.next('cohort'),
          merchantId: ports.merchantId,
          key: health.key,
          method: health.method,
          issuer: health.issuer,
          windowStart: Math.floor(at / HOUR_MS) * HOUR_MS - DETECTOR_WINDOW_MS,
          windowEnd: Math.floor(at / HOUR_MS) * HOUR_MS,
          attempts: health.attempts,
          successes: health.successes,
          wilsonLcb: health.wilsonLcb,
          baselineEwma: health.baseline,
          state: health.state,
          since: health.onsetAt ?? at,
          pausedUntil: null,
          canaryPct: null,
        })),
      )
      .onConflictDoNothing()
  }

  async function claimTick(at: number): Promise<boolean> {
    if (ports.leaseTicks !== true) return true
    const claimed = await ports.db
      .update(merchants)
      .set({ tickLeaseUntil: at + TICK_LEASE_MS })
      .where(
        and(
          eq(merchants.id, ports.merchantId),
          or(isNull(merchants.tickLeaseUntil), lt(merchants.tickLeaseUntil, at)),
        ),
      )
      .returning({ id: merchants.id })
    return claimed.length > 0
  }

  async function releaseTick(): Promise<void> {
    if (ports.leaseTicks !== true) return
    await ports.db
      .update(merchants)
      .set({ tickLeaseUntil: null })
      .where(eq(merchants.id, ports.merchantId))
  }

  async function tick(now?: number): Promise<TickStats> {
    const at = now ?? ports.clock.now()

    if (!(await claimTick(at))) {
      throw new TickBusyError('another tick is already running for this merchant')
    }

    try {
      return await runTick(at)
    } finally {
      await releaseTick()
    }
  }

  async function runTick(at: number): Promise<TickStats> {
    facts.killSwitchEngaged = ports.killSwitchEngaged?.() ?? false
    const merchantRow = await ports.db
      .select({ paused: merchants.paused })
      .from(merchants)
      .where(eq(merchants.id, ports.merchantId))
      .limit(1)
    facts.merchantPaused = merchantRow[0]?.paused ?? false

    const snapshot = detector.tick(at)
    const incidents: CohortHealth[] = []
    for (const health of snapshot) {
      if (health.state === 'DEGRADED') {
        incidents.push(health)
        pausedCohorts.add(health.key)
      } else {
        pausedCohorts.delete(health.key)
      }
    }

    await persistCohorts(at, snapshot)
    detector.prune(at - DETECTOR_RETENTION_MS)

    ticksSinceReload += 1
    if (ticksSinceReload >= BANDIT_RELOAD_TICKS) {
      ticksSinceReload = 0
      await banditStore.load(bandit)
    }

    const inboundStats = await inbound.process(at)
    const promisesBroken = await inbound.expirePromises(at)

    await orchestrator.settleFeedback(at, at - HOUR_MS)
    await banditStore.flush(bandit, at)
    const cycle = await orchestrator.runCycle(at)
    const drain = await executor.drain(at)

    return { cycle, drain, inbound: inboundStats, promisesBroken, incidents, snapshot }
  }

  return {
    restore: () => banditStore.load(bandit),
    ingest,
    tick,
    clock: ports.clock,
    detector,
    bandit,
    attribution,
    contexts,
    orchestrator,
    executor,
    inbound,
    outbox,
    facts,
    authority,
    costs,
    templates,
  }
}

export function channelCostsOf(costs: CostsConfig): { costFor: (channel: Channel) => Paise } {
  return { costFor: (channel) => paise(costs.channels[channel]?.direct_paise ?? 0) }
}
