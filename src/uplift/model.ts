import { z } from 'zod'

import {
  BASELINE_ACTION,
  encodeDecision,
  FEATURE_NAMES,
  type ActionFeatures,
  type CaseFeatures,
} from './features'
import { rawScore, scorerSchema, scorerWidth, sigmoid, type Scorer } from './scorer'

export class UpliftModelError extends Error {
  override readonly name = 'UpliftModelError'
}

const candidateSchema = z.object({
  learner: z.string().min(1),
  cvQini: z.number(),
  cvQiniStdError: z.number().nonnegative(),
  selected: z.boolean(),
})

const metricsSchema = z.object({
  learner: z.string().min(1),
  cvQini: z.number(),
  cvQiniStdError: z.number().nonnegative(),
  cvAuuc: z.number(),
  outOfFoldLogLoss: z.number().nonnegative(),
  outOfFoldBrier: z.number().nonnegative(),
  rows: z.number().int().positive(),
  treatedRows: z.number().int().nonnegative(),
  baselineRows: z.number().int().nonnegative(),
  positiveRate: z.number().min(0).max(1),
})

const provenanceSchema = z.object({
  trainedAt: z.string().min(1),
  datasetDigest: z.string().min(1),
  trainingSeed: z.number().int(),
  trainer: z.string().min(1),
  candidates: z.array(candidateSchema),
})

const actionSkillSchema = z.object({
  qini: z.number(),
  stdError: z.number().nonnegative(),
  rows: z.number().int().nonnegative(),
  folds: z.number().int().nonnegative(),
  trusted: z.boolean(),
})

const commonFields = {
  version: z.string().min(1),
  featureNames: z.array(z.string()),
  metrics: metricsSchema,
  actionSkill: z.record(z.string(), actionSkillSchema).default({}),
  provenance: provenanceSchema,
}

const modelSchema = z.discriminatedUnion('estimator', [
  z.object({
    ...commonFields,
    estimator: z.literal('outcome_difference'),
    link: z.literal('logistic'),
    scorer: scorerSchema,
  }),
  z.object({
    ...commonFields,
    estimator: z.literal('two_model'),
    link: z.literal('logistic'),
    treatedScorer: scorerSchema,
    controlScorer: scorerSchema,
  }),
])

export type UpliftModel = z.infer<typeof modelSchema>
export type ActionSkill = z.infer<typeof actionSkillSchema>

function actionSkillKey(action: ActionFeatures): string {
  return `${action.action}|${action.channel ?? ''}`
}

export function modelCanRank(model: UpliftModel, action: ActionFeatures): boolean {
  return model.actionSkill[actionSkillKey(action)]?.trusted === true
}

function probability(scorer: Scorer, row: readonly number[]): number {
  return sigmoid(rawScore(scorer, row))
}

export function predictUplift(
  model: UpliftModel,
  features: CaseFeatures,
  action: ActionFeatures,
): number {
  const acted = encodeDecision(features, action)
  const idle = encodeDecision(features, BASELINE_ACTION)

  if (model.estimator === 'two_model') {
    return probability(model.treatedScorer, acted) - probability(model.controlScorer, idle)
  }
  return probability(model.scorer, acted) - probability(model.scorer, idle)
}

function scorersOf(model: UpliftModel): readonly Scorer[] {
  return model.estimator === 'two_model'
    ? [model.treatedScorer, model.controlScorer]
    : [model.scorer]
}

export function parseUpliftModel(raw: unknown): UpliftModel {
  const parsed = modelSchema.safeParse(raw)
  if (!parsed.success) {
    throw new UpliftModelError(
      `stored uplift model is not readable:\n${parsed.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    )
  }

  const model = parsed.data

  if (model.featureNames.length !== FEATURE_NAMES.length) {
    throw new UpliftModelError(
      `stored model was trained on ${model.featureNames.length} features but the code now ` +
        `produces ${FEATURE_NAMES.length}. Retrain rather than predicting from a mismatched model.`,
    )
  }

  for (const [index, name] of FEATURE_NAMES.entries()) {
    if (model.featureNames[index] !== name) {
      throw new UpliftModelError(
        `feature ${index} is "${model.featureNames[index]}" in the stored model but "${name}" now. ` +
          `Retrain rather than silently mapping one feature onto another.`,
      )
    }
  }

  for (const scorer of scorersOf(model)) {
    const width = scorerWidth(scorer)
    if (width !== undefined && width > FEATURE_NAMES.length) {
      throw new UpliftModelError(
        `the stored scorer reads feature index ${width - 1} but only ${FEATURE_NAMES.length} ` +
          `features exist. The model and the encoder disagree.`,
      )
    }
  }

  return model
}

export function isInSample(model: UpliftModel, seed: number): boolean {
  return model.provenance.trainingSeed === seed
}
