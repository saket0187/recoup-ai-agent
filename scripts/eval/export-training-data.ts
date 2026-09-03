import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { paise } from '../../src/core/money'
import { decisions, riskCases } from '../../src/db/schema'
import type { PaymentMethod, Portfolio } from '../../src/domain/enums'
import {
  ACTION_FEATURE_NAMES,
  actionKey,
  BASELINE_ACTION,
  CASE_FEATURE_NAMES,
  encodeAction,
  encodeCase,
  FEATURE_NAMES,
} from '../../src/uplift/features'
import type { ActionFeatures, CaseFeatures } from '../../src/uplift/features'
import { MERCHANT_ID, runScenario } from '../lib/scenario'

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    accounts: { type: 'string' },
    out: { type: 'string' },
  },
})

const seed = values.seed === undefined ? 42 : Number(values.seed)
const accounts = values.accounts === undefined ? 4_000 : Number(values.accounts)
const outPath = values.out ?? './reports/training-data.jsonl'

const HOUR_MS = 3_600_000

process.stderr.write(`collecting decisions from ${accounts} accounts on seed ${seed}...\n`)

const scenario = await runScenario({
  seed,
  accounts,
  trafficPerHour: 0,
  label: 'export',
  upliftModelPath: null,
})

const windowMs = scenario.authority.cadence.attribution_window_hours * HOUR_MS

const caseRows = await scenario.handle.db.select().from(riskCases)
const decisionRows = await scenario.handle.db.select().from(decisions)

const caseById = new Map(caseRows.map((row) => [row.id, row]))

interface ExportedRow {
  readonly caseId: string
  readonly decisionId: string
  readonly at: number
  readonly arm: string
  readonly action: string
  readonly channel: string | null
  readonly treated: number
  readonly propensity: number
  readonly y: number
  readonly amountPaise: number
  readonly verdict: string
  readonly policyConstrained: number
  readonly hoursToRecovery: number | null
  readonly xCase: readonly number[]
  readonly actionKey: string
}

const rows: ExportedRow[] = []
const actionEncodings = new Map<string, number[]>()
let skippedUnresolvable = 0

function rememberAction(action: ActionFeatures): string {
  const key = actionKey(action)
  if (!actionEncodings.has(key)) actionEncodings.set(key, encodeAction(action))
  return key
}

rememberAction(BASELINE_ACTION)

for (const decision of decisionRows) {
  const riskCase = caseById.get(decision.caseId)
  if (riskCase === undefined) {
    skippedUnresolvable++
    continue
  }

  const snapshot = decision.featureSnapshot as Record<string, unknown>
  const portfolio = snapshot['portfolio']
  const failureClass = snapshot['failure_class']
  const method = snapshot['method']

  if (typeof portfolio !== 'string' || typeof failureClass !== 'string') {
    skippedUnresolvable++
    continue
  }

  const features: CaseFeatures = {
    outstandingPaise: paise(Number(snapshot['amount_paise'] ?? riskCase.amountPaise)),
    failureClass: failureClass as CaseFeatures['failureClass'],
    portfolio: portfolio as Portfolio,
    method: typeof method === 'string' ? (method as PaymentMethod) : undefined,
    attemptCount: Number(snapshot['attempt_count'] ?? 0),
    touchCount: Number(snapshot['touch_count'] ?? 0),
    daysSinceDue: Number(snapshot['days_since_due'] ?? 0),
    at: decision.at,
  }

  const action = {
    action: decision.chosenAction,
    channel: decision.chosenChannel ?? undefined,
  }

  const executed = decision.finalVerdict === 'EXECUTE' && decision.chosenAction !== 'WAIT'
  const recoveredAfter =
    riskCase.state === 'RECOVERED' &&
    riskCase.resolvedAt !== null &&
    riskCase.resolvedAt >= decision.at
      ? (riskCase.resolvedAt - decision.at) / HOUR_MS
      : null
  const recoveredInWindow = recoveredAfter !== null && recoveredAfter * HOUR_MS <= windowMs

  rows.push({
    caseId: decision.caseId,
    decisionId: decision.id,
    at: decision.at,
    arm: riskCase.arm,
    action: decision.chosenAction,
    channel: decision.chosenChannel ?? null,
    treated: executed ? 1 : 0,
    propensity: decision.propensity,
    y: recoveredInWindow ? 1 : 0,
    amountPaise: riskCase.amountPaise,
    verdict: decision.finalVerdict,
    policyConstrained: decision.policyEvaluations.some(
      (evaluation) => evaluation.verdict === 'DENY' || evaluation.verdict === 'DEFER',
    )
      ? 1
      : 0,
    hoursToRecovery: recoveredAfter,
    xCase: encodeCase(features),
    actionKey: rememberAction(executed ? action : BASELINE_ACTION),
  })
}

scenario.handle.close()

if (rows.length === 0) {
  throw new Error('the scenario produced no decisions, so there is nothing to train on')
}

const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
const digest = createHash('sha256').update(body).digest('hex')

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, body, 'utf8')
writeFileSync(
  `${outPath.replace(/\.jsonl$/, '')}.meta.json`,
  `${JSON.stringify(
    {
      featureNames: FEATURE_NAMES,
      caseFeatureNames: CASE_FEATURE_NAMES,
      actionFeatureNames: ACTION_FEATURE_NAMES,
      baselineActionKey: actionKey(BASELINE_ACTION),
      actionEncodings: Object.fromEntries(
        [...actionEncodings].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      seed,
      accounts,
      merchantId: MERCHANT_ID,
      attributionWindowHours: scenario.authority.cadence.attribution_window_hours,
      rows: rows.length,
      datasetDigest: digest,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

const treated = rows.filter((row) => row.treated === 1)
const baseline = rows.filter((row) => row.treated === 0)
const rate = (subset: readonly ExportedRow[]): string =>
  `${((subset.reduce((sum, row) => sum + row.y, 0) / Math.max(1, subset.length)) * 100).toFixed(1)}%`

console.log(`
  Training data: ${outPath}

  decisions               ${rows.length}
  distinct cases          ${new Set(rows.map((row) => row.caseId)).size}
  acted on                ${treated.length} (recovered in window ${rate(treated)})
  waited                  ${baseline.length} (recovered in window ${rate(baseline)})
  skipped                 ${skippedUnresolvable}
  features                ${FEATURE_NAMES.length}
  digest                  ${digest.slice(0, 16)}

  Features are encoded by the same TypeScript function that serves predictions, so
  the trainer never re-implements the encoding and train/serve skew is impossible.
`)
