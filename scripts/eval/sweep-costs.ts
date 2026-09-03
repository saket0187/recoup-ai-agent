import { mkdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { getConfig } from '../../src/core/config'
import { createRng } from '../../src/core/seeded-random'
import { excludesZero } from '../../src/core/statistics'
import { measure, type MeasurementResult } from '../../src/measurement/metrics'
import { MERCHANT_ID, runScenario } from '../lib/scenario'

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    accounts: { type: 'string' },
    out: { type: 'string' },
  },
})

const config = getConfig()
const seed = values.seed === undefined ? config.seed : Number(values.seed)
const accounts = values.accounts === undefined ? 1_000 : Number(values.accounts)
const outPath = values.out ?? './reports/cost-sensitivity.md'

const SCALES = [0, 0.1, 0.25, 0.5, 1, 2, 4] as const

interface SweepPoint {
  readonly scale: number
  readonly result: MeasurementResult
}

const points: SweepPoint[] = []

for (const scale of SCALES) {
  process.stderr.write(`annoyance scale ${scale}...\n`)
  const scenario = await runScenario({
    seed,
    accounts,
    trafficPerHour: 0,
    annoyanceScale: scale,
    label: `sweep-${scale}`,
  })
  const result = await measure(
    scenario.handle.db,
    MERCHANT_ID,
    scenario.authority,
    createRng(seed).derive(`sweep-${scale}`),
  )
  points.push({ scale, result })
  scenario.handle.close()
}

const pp = (value: number): string => `${(value * 100).toFixed(2)}pp`
const rate = (value: number): string => `${(value * 100).toFixed(1)}%`

const lines: string[] = []

lines.push('# Cost sensitivity')
lines.push('')
lines.push(
  `Seed \`${seed}\`, ${accounts} accounts per point. Only the annoyance component of contact cost`,
)
lines.push(
  'is varied; direct channel cost and risk cost are unchanged. A scale of 1 is the value in',
)
lines.push('`config/costs.yaml`. A scale of 0 means the agent treats contacting someone as free.')
lines.push('')
lines.push(
  'The question this answers: is the agent under-acting because contact is genuinely not worth it,',
)
lines.push('or because the assumed annoyance cost is too large relative to the uplift it can earn?')
lines.push('')

lines.push(
  '| Annoyance scale | Incremental fraction | 95% interval | Significant | Touches/case | Opt-outs | Recovery T vs C |',
)
lines.push('|---:|---:|---|---|---:|---:|---|')

for (const { scale, result } of points) {
  const fraction = result.incrementalRecoveredFraction
  const touches = (result.treatment.touches / Math.max(1, result.treatment.cases)).toFixed(2)
  lines.push(
    `| ${scale} | ${pp(fraction.estimate)} | ` +
      `[${(fraction.lower * 100).toFixed(2)}, ${(fraction.upper * 100).toFixed(2)}]pp | ` +
      `${excludesZero(fraction) ? '**yes**' : 'no'} | ${touches} | ${result.treatment.optOuts} | ` +
      `${rate(result.treatment.recoveryRate.estimate)} vs ${rate(result.control.recoveryRate.estimate)} |`,
  )
}
lines.push('')
lines.push(
  'Opt-outs are the price of the extra contact. Read the two columns together: a scale that',
)
lines.push('recovers more while opting out many more customers has not found free money, it has')
lines.push('chosen a different point on the same trade-off.')
lines.push('')

mkdirSync('./reports', { recursive: true })
writeFileSync(outPath, lines.join('\n'), 'utf8')

console.log(`\nwrote ${outPath}\n`)
console.log('  scale   incremental        touches/case   opt-outs   recovery T vs C')
for (const { scale, result } of points) {
  const fraction = result.incrementalRecoveredFraction
  const touches = (result.treatment.touches / Math.max(1, result.treatment.cases)).toFixed(2)
  console.log(
    `  ${String(scale).padEnd(7)}${pp(fraction.estimate).padStart(9)} ` +
      `[${(fraction.lower * 100).toFixed(1)}, ${(fraction.upper * 100).toFixed(1)}]`.padEnd(20) +
      `${touches.padStart(6)}   ${String(result.treatment.optOuts).padStart(8)}   ` +
      `${rate(result.treatment.recoveryRate.estimate)} vs ${rate(result.control.recoveryRate.estimate)}` +
      `${excludesZero(fraction) ? '  *' : ''}`,
  )
}
console.log('')
