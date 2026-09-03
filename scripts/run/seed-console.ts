import { existsSync, rmSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { getConfig } from '../../src/core/config'
import { formatINR } from '../../src/core/money'
import { MERCHANT_ID, runScenario } from '../lib/scenario'

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    accounts: { type: 'string' },
    traffic: { type: 'string' },
    db: { type: 'string' },
  },
})

const CONSOLE_ACCOUNTS = 900
const CONSOLE_TRAFFIC_PER_HOUR = 200

const config = getConfig()
const seed = values.seed === undefined ? config.seed : Number(values.seed)
const accounts = values.accounts === undefined ? CONSOLE_ACCOUNTS : Number(values.accounts)
const trafficPerHour =
  values.traffic === undefined ? CONSOLE_TRAFFIC_PER_HOUR : Number(values.traffic)
const dbPath = values.db ?? config.dbPath

for (const suffix of ['', '-wal', '-shm']) {
  const path = `${dbPath}${suffix}`
  if (existsSync(path)) rmSync(path)
}

process.stderr.write(`seeding ${dbPath} from ${accounts} accounts on seed ${seed}...\n`)

const scenario = await runScenario({
  seed,
  accounts,
  trafficPerHour,
  label: 'console',
  dbPath,
})

scenario.handle.close()

console.log(`
  Console database: ${dbPath}

  seed                      ${seed}
  accounts                  ${accounts}
  merchant                  ${MERCHANT_ID}
  charge attempts           ${scenario.simulation.chargeAttempts}
  webhooks accepted         ${scenario.receipts.accepted}
  degraded windows          ${scenario.incidents.length}
  billed                    ${formatINR(scenario.simulation.grossDuePaise)}
  replay                    ${(scenario.elapsedMs / 1000).toFixed(1)}s

  Start the console with \`npm run dev\`.
`)
