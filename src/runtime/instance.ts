import { existsSync, readFileSync } from 'node:fs'

import { RealClock } from '../core/clock'
import { getConfig } from '../core/config'
import { createRuntimeIdFactory } from '../core/identifiers'
import { createLogger } from '../core/logger'
import { createRng } from '../core/seeded-random'
import type { Database } from '../db/client'
import { loadCosts } from '../core/config-files'
import { merchants } from '../db/schema'
import { observationSenders, ObservationPaymentExecutor } from '../providers/observation'
import { parseUpliftModel, type UpliftModel } from '../uplift/model'
import { composeAgent, type Agent } from './compose'

const RUNTIME_MERCHANT_ID = 'merch_demo'
const RUNTIME_MERCHANT_NAME = 'Demo Merchant'

function loadModel(): UpliftModel | undefined {
  const path = './fixtures/uplift-model.json'
  if (!existsSync(path)) return undefined
  try {
    return parseUpliftModel(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

let cached: Promise<Agent> | undefined

async function build(db: Database, webhookSecret: string): Promise<Agent> {
  const config = getConfig()
  const clock = new RealClock()
  const model = loadModel()

  const agent = composeAgent({
    db,
    clock,
    ids: createRuntimeIdFactory(),
    rng: createRng(config.seed),
    logger: createLogger({ level: config.logLevel, clock }),
    seed: config.seed,
    merchantId: RUNTIME_MERCHANT_ID,
    merchantName: RUNTIME_MERCHANT_NAME,
    webhookSecret,
    payments: new ObservationPaymentExecutor(),
    senders: observationSenders(),
    dryRun: config.dryRun,
    killSwitchEngaged: () => getConfig().killSwitch,
    leaseTicks: true,
    ...(model === undefined ? {} : { upliftModel: model }),
  })

  await db
    .insert(merchants)
    .values({
      id: RUNTIME_MERCHANT_ID,
      name: RUNTIME_MERCHANT_NAME,
      timezone: 'Asia/Kolkata',
      marginRateBp: loadCosts().margin_rate_bp,
      paused: false,
      createdAt: clock.now(),
    })
    .onConflictDoNothing()

  await agent.restore()
  return agent
}

export function runtimeAgent(db: Database, webhookSecret: string): Promise<Agent> {
  cached ??= build(db, webhookSecret)
  return cached
}
