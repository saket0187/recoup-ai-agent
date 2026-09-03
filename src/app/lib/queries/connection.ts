import { readFileSync } from 'node:fs'

import { migrate } from 'drizzle-orm/libsql/migrator'

import { loadAuthority } from '../../../core/config-files'
import { getConfig } from '../../../core/config'
import { createRng } from '../../../core/seeded-random'
import { createDatabase, type Database } from '../../../db/client'
import { decisions, riskCases } from '../../../db/schema'
import { measure, type MeasurementResult } from '../../../measurement/metrics'

export const MERCHANT_ID = 'merch_demo'

let cached: Promise<Database> | undefined

async function openDatabase(): Promise<Database> {
  const handle = await createDatabase(getConfig().dbPath)
  await migrate(handle.db, { migrationsFolder: './drizzle' })
  return handle.db
}

export function consoleDb(): Promise<Database> {
  cached ??= openDatabase()
  return cached
}

export interface ModelProvenance {
  readonly version: string
  readonly inSample: boolean
}

export interface ConsoleState {
  readonly seeded: boolean
  readonly cases: number
  readonly decisions: number
  readonly seededAt: number | undefined
  readonly dbPath: string
  readonly model: ModelProvenance | undefined
}

export async function consoleState(): Promise<ConsoleState> {
  const db = await consoleDb()
  const [caseRows, decisionRows] = await Promise.all([
    db.select({ id: riskCases.id, at: riskCases.firstSeenAt }).from(riskCases),
    db.select({ id: decisions.id }).from(decisions),
  ])

  const times = caseRows.map((row) => row.at).sort((a, b) => b - a)

  let model: ModelProvenance | undefined
  try {
    const raw = JSON.parse(readFileSync('./fixtures/uplift-model.json', 'utf8')) as {
      version?: unknown
      provenance?: { trainingSeed?: unknown }
    }
    if (typeof raw.version === 'string') {
      model = {
        version: raw.version,
        inSample: raw.provenance?.trainingSeed === getConfig().seed,
      }
    }
  } catch {
    model = undefined
  }

  return {
    seeded: caseRows.length > 0,
    model,
    cases: caseRows.length,
    decisions: decisionRows.length,
    seededAt: times[0],
    dbPath: getConfig().dbPath,
  }
}

export async function measurement(): Promise<MeasurementResult> {
  const db = await consoleDb()
  return measure(db, MERCHANT_ID, loadAuthority(), createRng(getConfig().seed).derive('console'))
}
