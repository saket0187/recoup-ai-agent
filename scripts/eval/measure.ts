import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { getConfig } from '../../src/core/config'
import { formatINRCompact, paise } from '../../src/core/money'
import { createRng } from '../../src/core/seeded-random'
import { bootstrapDifferenceOfMeans, excludesZero } from '../../src/core/statistics'
import { ALL_FEATURES, type EngineFeatures } from '../../src/decision/engine'
import { measure, type MeasurementResult } from '../../src/measurement/metrics'
import { MERCHANT_ID, runScenario } from '../lib/scenario'
import { isInSample } from '../../src/uplift/model'

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    accounts: { type: 'string' },
    traffic: { type: 'string' },
    out: { type: 'string' },
  },
})

function trainingSeedOf(path = './fixtures/uplift-model.json'): number | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      provenance?: { trainingSeed?: unknown }
    }
    const value = raw.provenance?.trainingSeed
    return typeof value === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

const config = getConfig()
const trainingSeed = trainingSeedOf()
const heldOutSeed = trainingSeed === undefined ? config.seed : trainingSeed + 1
const seed = values.seed === undefined ? heldOutSeed : Number(values.seed)
const askedForTrainingSeed = values.seed !== undefined && seed === trainingSeed

if (trainingSeed !== undefined && values.seed === undefined) {
  process.stderr.write(
    `the committed model was trained on seed ${trainingSeed}; measuring on held-out seed ${seed}\n`,
  )
}

if (askedForTrainingSeed) {
  process.stderr.write(
    `\n  WARNING: seed ${seed} is the seed this model was trained on.\n` +
      `  Everything below is training-set performance and overstates the model.\n\n`,
  )
}
const accounts = values.accounts === undefined ? 600 : Number(values.accounts)
const trafficPerHour = values.traffic === undefined ? 300 : Number(values.traffic)
const outPath = values.out ?? './reports/measurement.md'

interface Ablation {
  readonly id: string
  readonly label: string
  readonly rationale: string
  readonly features: EngineFeatures
}

const ABLATIONS: readonly Ablation[] = [
  {
    id: 'full',
    label: 'Full agent',
    rationale: 'every layer enabled',
    features: ALL_FEATURES,
  },
  {
    id: 'no-timing',
    label: 'Without timing',
    rationale: 'bandit arms stop being bucketed by day and hour, so timing cannot be learned',
    features: { ...ALL_FEATURES, timeBucketedArms: false },
  },
  {
    id: 'no-diagnosis',
    label: 'Without diagnosis',
    rationale: 'every failure is treated as AMBIGUOUS, so the playbook cannot specialise',
    features: { ...ALL_FEATURES, diagnosis: false },
  },
  {
    id: 'no-uplift',
    label: 'Without uplift',
    rationale: 'scores raw success probability instead of uplift over doing nothing',
    features: { ...ALL_FEATURES, uplift: false },
  },
  {
    id: 'no-policy',
    label: 'Without the policy gate',
    rationale: 'the safety argument: what the same engine does with compliance removed',
    features: { ...ALL_FEATURES, policyGate: false },
  },
  {
    id: 'no-reviewer',
    label: 'Without the reviewer',
    rationale: 'drafted copy goes out without an independent veto on what it may contain',
    features: { ...ALL_FEATURES, reviewer: false },
  },
  {
    id: 'no-allocation',
    label: 'Without allocation',
    rationale: 'every admissible action is sent, with no per-cycle budget or capacity limit',
    features: { ...ALL_FEATURES, allocation: false },
  },
  {
    id: 'no-skill-gate',
    label: 'Without the action-skill gate',
    rationale: 'the model scores every action, including the ones it ranks no better than chance',
    features: { ...ALL_FEATURES, actionSkillGate: false },
  },
  {
    id: 'no-floor',
    label: 'Without the incumbent floor',
    rationale:
      'the agent may fall below the fixed schedule when its own economics say to do nothing',
    features: { ...ALL_FEATURES, incumbentFloor: false },
  },
]

interface AblationOutcome {
  readonly ablation: Ablation
  readonly result: MeasurementResult
  readonly elapsedMs: number
}

const outcomes: AblationOutcome[] = []
let upliftModelVersion: string | undefined
let inSample = false

for (const ablation of ABLATIONS) {
  process.stderr.write(`running ${ablation.id}...\n`)
  const scenario = await runScenario({
    seed,
    accounts,
    trafficPerHour,
    features: ablation.features,
    label: ablation.id,
  })
  const result = await measure(
    scenario.handle.db,
    MERCHANT_ID,
    scenario.authority,
    createRng(seed).derive(`bootstrap-${ablation.id}`),
  )
  upliftModelVersion = scenario.upliftModel?.version
  if (scenario.upliftModel !== undefined && isInSample(scenario.upliftModel, seed)) {
    inSample = true
  }
  outcomes.push({ ablation, result, elapsedMs: scenario.elapsedMs })
  scenario.handle.close()
}

const money = (value: number): string => formatINRCompact(paise(Math.round(value)))
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

const lines: string[] = []

lines.push('# Measurement report')
lines.push('')
lines.push(
  `Seed \`${seed}\`, ${accounts} synthetic accounts per arm, bootstrap of 1,000 resamples for every interval.`,
)
lines.push('')
lines.push('Every figure below comes from a simulated world whose constants are assumptions, not')
lines.push(
  'measurements. They are documented in `docs/simulation-assumptions.md`. Treat the sign and',
)
lines.push(
  'the ordering as the claim; do not quote the rupee figures as though they were observed.',
)
lines.push('')

if (upliftModelVersion !== undefined) {
  lines.push(
    inSample
      ? `> **In-sample warning.** The uplift model \`${upliftModelVersion}\` was trained on the same ` +
          `seed this report evaluates. These figures are training-set performance and overstate the ` +
          `model. Re-run with a different \`--seed\` for an honest estimate.`
      : `Uplift model \`${upliftModelVersion}\`, evaluated out of sample on seed \`${seed}\`.`,
  )
  lines.push('')
}

lines.push('## Headline: incremental recovery against a randomised control')
lines.push('')
lines.push(
  'Two estimators are reported. Absolute rupees per case is the figure people ask for, but its',
)
lines.push(
  'variance is dominated by how much invoice sizes differ rather than by the treatment. The',
)
lines.push(
  'recovered *fraction* of each billed amount removes that variance and is the more sensitive',
)
lines.push('test of whether the agent actually helped.')
lines.push('')
lines.push(
  'The stratified column re-weights each amount-band by failure-class stratum by its own share of',
)
lines.push(
  'the cases, which is how the arms were assigned in the first place. It estimates the same',
)
lines.push('quantity with less variance, so it is the column to read.')
lines.push('')
lines.push(
  '| Configuration | Incremental ₹/case | 95% interval | Fraction | 95% interval | Stratified | 95% interval | Significant |',
)
lines.push('|---|---:|---|---:|---|---:|---|---|')
for (const { ablation, result } of outcomes) {
  const fraction = result.incrementalRecoveredFraction
  const strat = result.stratifiedRecoveredFraction
  lines.push(
    `| ${ablation.label} | ${money(result.incrementalPerCasePaise.estimate)} | ` +
      `[${money(result.incrementalPerCasePaise.lower)}, ${money(result.incrementalPerCasePaise.upper)}] | ` +
      `${(fraction.estimate * 100).toFixed(2)}pp | ` +
      `[${(fraction.lower * 100).toFixed(2)}, ${(fraction.upper * 100).toFixed(2)}]pp | ` +
      `${(strat.estimate * 100).toFixed(2)}pp | ` +
      `[${(strat.lower * 100).toFixed(2)}, ${(strat.upper * 100).toFixed(2)}]pp | ` +
      `${excludesZero(strat) ? '**yes**' : 'no'} |`,
  )
}
lines.push('')
lines.push('Recovery bought with spend is not the same as recovery. The engine maximises value')
lines.push('net of what it spends, so this is the estimator that scores it on its own objective.')
lines.push('')
lines.push(
  '| Configuration | Incremental net ₹/case | 95% interval | Significant | Spend/case T vs C |',
)
lines.push('|---|---:|---|---|---|')
for (const { ablation, result } of outcomes) {
  const net = result.incrementalNetValuePerCasePaise
  const spend = (metrics: (typeof result)['treatment']): string =>
    money(metrics.contactCostPaise / Math.max(1, metrics.cases))
  lines.push(
    `| ${ablation.label} | ${money(net.estimate)} | ` +
      `[${money(net.lower)}, ${money(net.upper)}] | ` +
      `${excludesZero(net) ? '**yes**' : 'no'} | ` +
      `${spend(result.treatment)} vs ${spend(result.control)} |`,
  )
}
lines.push('')
lines.push('| Configuration | Recovery rate T vs C | Cases T / C |')
lines.push('|---|---|---|')
for (const { ablation, result } of outcomes) {
  lines.push(
    `| ${ablation.label} | ${pct(result.treatment.recoveryRate.estimate)} vs ` +
      `${pct(result.control.recoveryRate.estimate)} | ${result.treatment.cases} / ${result.control.cases} |`,
  )
}
lines.push('')

const baseline = outcomes.find((entry) => entry.ablation.id === 'full')
if (baseline !== undefined) {
  lines.push('## What each layer contributes')
  lines.push('')
  lines.push(
    "Each row bootstraps the difference between the full agent's treatment arm and the same",
  )
  lines.push(
    'arm with one layer disabled, on the same world and seed. This is a more powerful test',
  )
  lines.push(
    'than either configuration against control, because it removes the between-world variance.',
  )
  lines.push('')
  lines.push(
    '| Layer removed | Change in recovered fraction | 95% interval | Layer earns its place |',
  )
  lines.push('|---|---:|---|---|')

  for (const { ablation, result } of outcomes) {
    if (ablation.id === 'full') continue
    const contribution = bootstrapDifferenceOfMeans(
      baseline.result.treatment.recoveredFractionPerCase,
      result.treatment.recoveredFractionPerCase,
      createRng(seed).derive(`contribution-${ablation.id}`),
      { iterations: 1_000 },
    )
    lines.push(
      `| ${ablation.label} | ${(contribution.estimate * 100).toFixed(2)}pp | ` +
        `[${(contribution.lower * 100).toFixed(2)}, ${(contribution.upper * 100).toFixed(2)}]pp | ` +
        `${
          !excludesZero(contribution)
            ? 'not detectable'
            : contribution.estimate > 0
              ? '**yes**'
              : '**no, it costs recovery**'
        } |`,
    )
  }
  lines.push('')
  lines.push(
    'A positive change means the full agent recovers more than the version without that layer,',
  )
  lines.push('so the layer is pulling its weight.')
  lines.push('')
}

lines.push('## Harm')
lines.push('')
lines.push(
  '| Configuration | Touches per case | Opt-outs | False dunning | Over-contact | Policy violations |',
)
lines.push('|---|---:|---:|---:|---:|---:|')
for (const { ablation, result } of outcomes) {
  const touches = (result.treatment.touches / Math.max(1, result.treatment.cases)).toFixed(2)
  lines.push(
    `| ${ablation.label} | ${touches} | ${result.treatment.optOuts} | ` +
      `${result.treatment.falseDunningContacts} | ${result.treatment.overContactIncidents} | ` +
      `${result.policyViolations} |`,
  )
}
lines.push('')
lines.push(
  'A policy violation is a message that was actually sent despite a `DENY` recorded against it.',
)
lines.push('Under the full agent this must be zero. The no-policy row is the counterfactual: it is')
lines.push('the same engine with compliance removed, and it exists to make the trade-off visible.')
lines.push('')

lines.push('## What each ablation removes')
lines.push('')
lines.push('| Configuration | What is disabled |')
lines.push('|---|---|')
for (const { ablation } of outcomes) {
  lines.push(`| ${ablation.label} | ${ablation.rationale} |`)
}
lines.push('')

lines.push('## System')
lines.push('')
lines.push(
  '| Configuration | Decisions | Propensity coverage | Unmapped | Dead-lettered | Replay |',
)
lines.push('|---|---:|---:|---:|---:|---:|')
for (const { ablation, result, elapsedMs } of outcomes) {
  lines.push(
    `| ${ablation.label} | ${result.decisionCount} | ${pct(result.propensityCoverage)} | ` +
      `${pct(result.unmappedRate)} | ${result.deadLetteredActions} | ${(elapsedMs / 1000).toFixed(1)}s |`,
  )
}
lines.push('')

lines.push('## Not measured here')
lines.push('')
lines.push(
  '- **Allocation** and **model-in-the-loop** ablations are absent because those layers are',
)
lines.push('  not built. Reporting a bar for them would be fabricating a number.')
lines.push('- **Churn avoided** is not reported: the simulator models cancellation, but the engine')
lines.push('  never observes it, so attributing it would require reading latent state.')
lines.push('- Every arm shares one seed and one world, so differences are attributable to the')
lines.push('  configuration rather than to the population.')
lines.push('')

mkdirSync('./reports', { recursive: true })
writeFileSync(outPath, lines.join('\n'), 'utf8')

if (inSample) {
  console.warn(
    `\n  WARNING: uplift model ${upliftModelVersion} was trained on seed ${seed}.` +
      `\n  These numbers are in-sample. Re-run with a different --seed.\n`,
  )
}

console.log(`\nwrote ${outPath}\n`)
if (baseline !== undefined) {
  console.log('  layer contribution (full agent minus the version without it):')
  for (const { ablation, result } of outcomes) {
    if (ablation.id === 'full') continue
    const contribution = bootstrapDifferenceOfMeans(
      baseline.result.treatment.recoveredFractionPerCase,
      result.treatment.recoveredFractionPerCase,
      createRng(seed).derive(`contribution-${ablation.id}`),
      { iterations: 1_000 },
    )
    console.log(
      `    ${ablation.label.padEnd(28)}${(contribution.estimate * 100).toFixed(2).padStart(7)}pp ` +
        `[${(contribution.lower * 100).toFixed(2)}, ${(contribution.upper * 100).toFixed(2)}]` +
        `${
          !excludesZero(contribution)
            ? ''
            : contribution.estimate > 0
              ? '  significant gain'
              : '  SIGNIFICANT LOSS'
        }`,
    )
  }
  console.log('')
}
for (const { ablation, result } of outcomes) {
  const net = result.incrementalNetValuePerCasePaise
  console.log(
    `  net  ${ablation.label.padEnd(28)}${money(net.estimate).padStart(10)}   ` +
      `[${money(net.lower)}, ${money(net.upper)}]${excludesZero(net) ? '  significant' : ''}`,
  )
}
console.log('')
for (const { ablation, result } of outcomes) {
  const fraction = result.incrementalRecoveredFraction
  console.log(
    `  ${ablation.label.padEnd(28)}` +
      `${money(result.incrementalPerCasePaise.estimate).padStart(10)}   ` +
      `${(fraction.estimate * 100).toFixed(2).padStart(6)}pp ` +
      `[${(fraction.lower * 100).toFixed(2)}, ${(fraction.upper * 100).toFixed(2)}]` +
      `${excludesZero(fraction) ? '  significant' : ''}`,
  )
}
console.log('')
