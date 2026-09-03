import { parseArgs } from 'node:util'

import { istDateKey, toIst } from '../../src/core/calendar'
import { getConfig } from '../../src/core/config'
import { formatINR, formatINRCompact, paise, subP } from '../../src/core/money'
import { createRng } from '../../src/core/seeded-random'
import { excludesZero } from '../../src/core/statistics'
import { measure } from '../../src/measurement/metrics'
import { MERCHANT_ID, runScenario } from '../lib/scenario'
import { isInSample } from '../../src/uplift/model'

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    accounts: { type: 'string' },
    traffic: { type: 'string' },
  },
})

const config = getConfig()
const seed = values.seed === undefined ? config.seed : Number(values.seed)
const accounts = values.accounts === undefined ? 2_000 : Number(values.accounts)
const traffic = values.traffic === undefined ? 400 : Number(values.traffic)

for (const [name, value] of [
  ['seed', seed],
  ['accounts', accounts],
  ['traffic', traffic],
] as const) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`--${name} must be a non-negative integer`)
  }
}

const scenario = await runScenario({ seed, accounts, trafficPerHour: traffic, label: 'demo' })
const result = await measure(
  scenario.handle.db,
  MERCHANT_ID,
  scenario.authority,
  createRng(seed).derive('bootstrap'),
)

const row = (label: string, value: string): string => `  ${label.padEnd(34)}${value}`
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const pair = (left: string | number, right: string | number): string =>
  `${String(left).padEnd(18)}${String(right)}`

function clockTime(at: number): string {
  const parts = toIst(at)
  return `${istDateKey(at)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

const money = (value: number): string => formatINRCompact(paise(Math.round(value)))
const lines: string[] = ['']

lines.push('  Recoup AI Agent: full loop over a simulated world')
lines.push('  ' + '─'.repeat(62))
lines.push(row('seed', String(seed)))
lines.push(
  row(
    'window',
    `${istDateKey(scenario.timeline.startAt)} → ${istDateKey(scenario.timeline.endAt)} (${scenario.timeline.durationDays}d)`,
  ),
)
lines.push(row('wall-clock to replay', `${(scenario.elapsedMs / 1000).toFixed(1)} s`))
lines.push(row('config execution mode', config.dryRun ? 'DRY_RUN' : 'LIVE'))
lines.push('')

lines.push('  Signal')
lines.push('  ' + '─'.repeat(62))
lines.push(
  row(
    'payment attempts observed',
    String(scenario.backgroundAttempts + scenario.receipts.accepted),
  ),
)
lines.push(row('webhooks accepted', String(scenario.receipts.accepted)))
lines.push(
  row(
    'rejected / dead-lettered',
    `${scenario.receipts.rejected} / ${scenario.receipts.deadLettered}`,
  ),
)
lines.push(row('cases opened', String(result.treatment.cases + result.control.cases)))
lines.push(row('unmapped diagnoses', pct(result.unmappedRate)))
lines.push('')

lines.push('  Degradation')
lines.push('  ' + '─'.repeat(62))
lines.push(row('degraded windows', String(scenario.incidents.length)))
const firstIncident = scenario.incidents[0]
if (firstIncident !== undefined) {
  lines.push(row('first incident', `${firstIncident.health.key} at ${clockTime(firstIncident.at)}`))
  if (firstIncident.health.onsetAt !== undefined) {
    lines.push(row('  onset (CUSUM)', clockTime(firstIncident.health.onsetAt)))
  }
}
lines.push('')

lines.push('  Headline: incremental recovery vs a randomised control')
lines.push('  ' + '─'.repeat(62))
lines.push(
  row(
    'incremental per case',
    `${money(result.incrementalPerCasePaise.estimate)}  [${money(result.incrementalPerCasePaise.lower)}, ${money(result.incrementalPerCasePaise.upper)}]`,
  ),
)
lines.push(
  row(
    'incremental across the arm',
    `${money(result.incrementalTotalPaise.estimate)}  [${money(result.incrementalTotalPaise.lower)}, ${money(result.incrementalTotalPaise.upper)}]`,
  ),
)
lines.push(
  row(
    'incremental recovered fraction',
    `${(result.incrementalRecoveredFraction.estimate * 100).toFixed(2)}pp  ` +
      `[${(result.incrementalRecoveredFraction.lower * 100).toFixed(2)}, ` +
      `${(result.incrementalRecoveredFraction.upper * 100).toFixed(2)}]pp`,
  ),
)
lines.push(
  row(
    'significant at 95%',
    excludesZero(result.incrementalRecoveredFraction)
      ? 'yes (on the fraction estimator)'
      : 'no, both intervals span zero',
  ),
)

const modelVersion = scenario.upliftModel?.version
const inSample = scenario.upliftModel !== undefined && isInSample(scenario.upliftModel, seed)

if (inSample) {
  lines.push('')
  lines.push(`  IN-SAMPLE: uplift model ${modelVersion} was trained on seed ${seed}.`)
  lines.push('  These figures are training-set performance and overstate the model.')
  lines.push('  Run `npm run measure -- --seed 43` for an out-of-sample estimate.')
}
lines.push('')

lines.push('  Treatment vs control')
lines.push('  ' + '─'.repeat(62))
lines.push(row('', pair('treatment', 'control')))
lines.push(row('cases', pair(result.treatment.cases, result.control.cases)))
lines.push(
  row(
    'recovery rate',
    pair(pct(result.treatment.recoveryRate.estimate), pct(result.control.recoveryRate.estimate)),
  ),
)
lines.push(
  row(
    'touches per case',
    pair(
      (result.treatment.touches / Math.max(1, result.treatment.cases)).toFixed(2),
      (result.control.touches / Math.max(1, result.control.cases)).toFixed(2),
    ),
  ),
)
lines.push(
  row(
    'median days to recovery',
    pair(
      result.treatment.medianDaysToRecovery.toFixed(1),
      result.control.medianDaysToRecovery.toFixed(1),
    ),
  ),
)
lines.push('')

lines.push('  Harm: reported whether or not it flatters the system')
lines.push('  ' + '─'.repeat(62))
lines.push(row('', pair('treatment', 'control')))
lines.push(row('opt-outs', pair(result.treatment.optOuts, result.control.optOuts)))
lines.push(
  row(
    'false dunning (already paid)',
    pair(result.treatment.falseDunningContacts, result.control.falseDunningContacts),
  ),
)
lines.push(
  row(
    'over-contact incidents',
    pair(result.treatment.overContactIncidents, result.control.overContactIncidents),
  ),
)
lines.push(row('policy violations on sent actions', String(result.policyViolations)))
lines.push(row('dead-lettered actions', String(result.deadLetteredActions)))
lines.push('')

lines.push('  Gates and inbound')
lines.push('  ' + '─'.repeat(62))
lines.push(row('actions scheduled', String(scenario.gating.scheduled)))
lines.push(row('vetoed by the reviewer', String(scenario.gating.reviewerBlocked)))
lines.push(row('deferred by the budget', String(scenario.gating.allocationDeferred)))
lines.push(row('replies read', String(scenario.inbound.processed)))
lines.push(
  row(
    'promises recorded / broken',
    `${scenario.inbound.promisesRecorded} / ${scenario.promisesBroken}`,
  ),
)
lines.push(row('disputes opened', String(scenario.inbound.disputesOpened)))
lines.push(row('escalated to a human', String(scenario.inbound.escalated)))
lines.push('')

lines.push('  Audit')
lines.push('  ' + '─'.repeat(62))
lines.push(row('decisions recorded', String(result.decisionCount)))
lines.push(row('propensity coverage', pct(result.propensityCoverage)))
lines.push(row('bandit arms learned', String(scenario.banditArms)))
lines.push(
  row(
    'attribution credited / missed',
    `${scenario.attribution.credited} / ${scenario.attribution.expired}`,
  ),
)
lines.push('')

lines.push('  Money')
lines.push('  ' + '─'.repeat(62))
lines.push(row('billed', formatINR(scenario.population.totalAtRiskPaise)))
lines.push(row('captured', formatINR(scenario.simulation.grossCapturedPaise)))
lines.push(
  row(
    'left on the table',
    formatINR(subP(scenario.population.totalAtRiskPaise, scenario.simulation.grossCapturedPaise)),
  ),
)
lines.push('')
lines.push('  Run `npm run measure` for the ablation table.')
lines.push('  Simulation constants are documented in docs/simulation-assumptions.md.')
lines.push('')

console.log(lines.join('\n'))
scenario.handle.close()
