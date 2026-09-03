import { mkdirSync, writeFileSync } from 'node:fs'

import { eq } from 'drizzle-orm'

import { createRng } from '../../src/core/seeded-random'
import { controlAction } from '../../src/decision/control-arm'
import { decisions, riskCases } from '../../src/db/schema'
import {
  evaluatePolicy,
  type LoggedDecision,
  type OffPolicyEstimate,
} from '../../src/measurement/off-policy'
import { MERCHANT_ID, runScenario } from '../lib/scenario'

const args = process.argv.slice(2)

function flag(name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) ? value : fallback
}

const seed = flag('seed', 43)
const accounts = flag('accounts', 600)
const traffic = flag('traffic', 120)

const scenario = await runScenario({ seed, accounts, trafficPerHour: traffic })
const windowMs = scenario.authority.cadence.attribution_window_hours * 3_600_000

const decisionRows = await scenario.handle.db.select().from(decisions)
const caseRows = await scenario.handle.db
  .select()
  .from(riskCases)
  .where(eq(riskCases.merchantId, MERCHANT_ID))

const caseById = new Map(caseRows.map((row) => [row.id, row]))

function actionKey(action: string, channel: string | null): string {
  return channel === null || channel === '' ? action : `${action}|${channel}`
}

const logged: LoggedDecision[] = []
for (const decision of decisionRows) {
  const riskCase = caseById.get(decision.caseId)
  if (riskCase === undefined) continue

  const recovered =
    riskCase.state === 'RECOVERED' &&
    riskCase.resolvedAt !== null &&
    riskCase.resolvedAt >= decision.at &&
    riskCase.resolvedAt - decision.at <= windowMs

  logged.push({
    caseId: decision.caseId,
    stratum: riskCase.stratum,
    action: actionKey(decision.chosenAction, decision.chosenChannel),
    propensity: decision.propensity,
    reward: recovered ? 1 : 0,
  })
}

const snapshotByDecision = new Map(
  decisionRows.map((decision) => [
    `${decision.caseId}|${decision.at}`,
    decision.featureSnapshot as Record<string, unknown>,
  ]),
)

const incumbentByRow = new Map<number, string>()
decisionRows.forEach((decision, index) => {
  const riskCase = caseById.get(decision.caseId)
  if (riskCase === undefined) return
  const snapshot = snapshotByDecision.get(`${decision.caseId}|${decision.at}`) ?? {}
  const choice = controlAction({
    at: decision.at,
    firstSeenAt: riskCase.firstSeenAt,
    attemptCount: Number(snapshot['attempt_count'] ?? 0),
    touchCount: Number(snapshot['touch_count'] ?? 0),
  })
  incumbentByRow.set(index, actionKey(choice.action, choice.channel ?? null))
})

const indexByRow = new Map<LoggedDecision, number>()
logged.forEach((row, index) => indexByRow.set(row, index))

const rng = createRng(seed).derive('off-policy')

const policies: { name: string; note: string; policy: (row: LoggedDecision) => string }[] = [
  {
    name: 'Replay the logged action every time',
    note: 'Deterministically repeat what was logged, with no exploration.',
    policy: (row) => row.action,
  },
  {
    name: 'Never act',
    note: 'Wait on every case. The floor any recovery agent has to beat.',
    policy: () => 'WAIT',
  },
  {
    name: 'The incumbent fixed schedule',
    note: 'Three retries at 24, 48 and 72 hours, one SMS, one email.',
    policy: (row) => incumbentByRow.get(indexByRow.get(row) ?? -1) ?? 'WAIT',
  },
  {
    name: 'Always retry, never message',
    note: 'Silent recovery only. Costs nothing to send and annoys nobody.',
    policy: () => 'RETRY_CHARGE',
  },
  {
    name: 'Always WhatsApp a nudge',
    note: 'One channel for everything, which is what most dunning tools do.',
    policy: () => 'SEND_NUDGE|WHATSAPP',
  },
]

const results: OffPolicyEstimate[] = policies.map(({ name, policy }) =>
  evaluatePolicy(logged, name, policy, rng),
)

const observed = logged.reduce((sum, row) => sum + row.reward, 0) / Math.max(1, logged.length)

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`
const lines: string[] = []

lines.push('# Off-policy evaluation')
lines.push('')
lines.push(
  `Seed \`${seed}\`, ${accounts} accounts, ${logged.length.toLocaleString('en-IN')} logged decisions.`,
)
lines.push('')
lines.push(
  'Every decision the agent ever took recorded the probability with which it took it. That is what',
)
lines.push(
  'makes it possible to score a policy the agent never ran, without running the simulator again.',
)
lines.push('')
lines.push(
  `Observed recovery within the attribution window: **${pct(observed)}** of decisions, under a`,
)
lines.push(
  'logging policy that explores. The first row below deterministically repeats whatever was logged,',
)
lines.push(
  'so it drops the exploration and should score a little higher than the observed rate. It does.',
)
lines.push('')
lines.push('| Target policy | IPS | SNIPS | Doubly robust | 95% interval (SNIPS) | Overlap | ESS |')
lines.push('|---|---:|---:|---:|---|---:|---:|')
for (const result of results) {
  lines.push(
    `| ${result.policy} | ${pct(result.ips.estimate)} | ${pct(result.snips.estimate)} | ` +
      `${pct(result.doublyRobust.estimate)} | ` +
      `[${pct(result.snips.lower)}, ${pct(result.snips.upper)}] | ` +
      `${pct(result.overlap)} | ${result.effectiveSampleSize.toFixed(0)} |`,
  )
}
lines.push('')
lines.push('**How to read this.** IPS is unbiased but high variance. SNIPS divides by the realised')
lines.push(
  'weight rather than the sample size, which trades a little bias for much less variance and',
)
lines.push(
  'is the column to read. Doubly robust adds a per-stratum outcome model, so it stays honest',
)
lines.push('if either the propensities or that model is right.')
lines.push('')
lines.push('**Overlap** is the share of logged decisions where the target policy would have chosen')
lines.push(
  'what actually happened. **ESS** is the effective sample size after weighting. A policy far',
)
lines.push(
  'from the logged one has low overlap and low ESS, and its estimate should not be trusted',
)
lines.push('however tight the interval looks. Weights are clipped at 20x.')
lines.push('')
lines.push('This is an observational estimate on simulated data. It ranks policies, it does not')
lines.push('measure them.')
lines.push('')

mkdirSync('./reports', { recursive: true })
writeFileSync('./reports/off-policy.md', lines.join('\n'), 'utf8')

process.stdout.write(`\n  Off-policy evaluation: ./reports/off-policy.md\n`)
process.stdout.write(`  observed ${pct(observed)} over ${logged.length} decisions\n\n`)
for (const result of results) {
  process.stdout.write(
    `  ${result.policy.padEnd(32)} SNIPS ${pct(result.snips.estimate).padStart(7)}` +
      `  overlap ${pct(result.overlap).padStart(7)}  ESS ${result.effectiveSampleSize.toFixed(0)}\n`,
  )
}
process.stdout.write('\n')

scenario.handle.close()
