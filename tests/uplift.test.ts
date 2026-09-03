import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { paise } from '../src/core/money'
import {
  ACTION_FEATURE_NAMES,
  actionKey,
  BASELINE_ACTION,
  CASE_FEATURE_NAMES,
  encodeAction,
  encodeCase,
  encodeDecision,
  FEATURE_NAMES,
  type ActionFeatures,
  type CaseFeatures,
} from '../src/uplift/features'
import { parseUpliftModel, predictUplift, UpliftModelError } from '../src/uplift/model'
import { rawScore, ScorerError, sigmoid, scorerWidth } from '../src/uplift/scorer'

const AT = Date.UTC(2025, 3, 15, 9, 30)

function caseFeatures(overrides: Partial<CaseFeatures> = {}): CaseFeatures {
  return {
    outstandingPaise: paise(250_000),
    failureClass: 'FUNDS_TIMING',
    portfolio: 'd2c_subscription',
    method: 'upi',
    attemptCount: 1,
    touchCount: 0,
    daysSinceDue: 2,
    at: AT,
    ...overrides,
  }
}

const NUDGE: ActionFeatures = { action: 'SEND_NUDGE', channel: 'WHATSAPP' }

describe('feature encoding', () => {
  it('splits into a case block and an action block that concatenate to the whole', () => {
    const features = caseFeatures()
    expect([...encodeCase(features), ...encodeAction(NUDGE)]).toEqual(
      encodeDecision(features, NUDGE),
    )
    expect(CASE_FEATURE_NAMES.length + ACTION_FEATURE_NAMES.length).toBe(FEATURE_NAMES.length)
  })

  it('varies with attempt count, touch count and age', () => {
    const base = encodeCase(caseFeatures())
    for (const override of [{ attemptCount: 4 }, { touchCount: 3 }, { daysSinceDue: 30 }]) {
      expect(encodeCase(caseFeatures(override))).not.toEqual(base)
    }
  })

  it('caps unbounded counters so a runaway case cannot dominate the fit', () => {
    const capped = encodeCase(caseFeatures({ attemptCount: 500, touchCount: 500 }))
    const atCap = encodeCase(caseFeatures({ attemptCount: 10, touchCount: 10 }))
    expect(capped).toEqual(atCap)
  })

  it('distinguishes every action from doing nothing', () => {
    const idle = encodeAction(BASELINE_ACTION)
    for (const action of ['RETRY_CHARGE', 'OFFER_DISCOUNT', 'MANDATE_REPAIR'] as const) {
      expect(encodeAction({ action, channel: undefined })).not.toEqual(idle)
    }
  })

  it('names an action and channel pair uniquely', () => {
    expect(actionKey(NUDGE)).toBe('SEND_NUDGE|WHATSAPP')
    expect(actionKey(BASELINE_ACTION)).toBe('WAIT|')
  })
})

describe('scorer', () => {
  const linear = {
    kind: 'linear' as const,
    bias: 0.5,
    weights: [2, -1],
    means: [0, 0],
    scales: [1, 1],
  }

  it('evaluates a linear scorer as a standardised dot product', () => {
    expect(rawScore(linear, [1, 1])).toBeCloseTo(1.5, 12)
  })

  it('walks a tree ensemble to its leaves', () => {
    const ensemble = {
      kind: 'tree_ensemble' as const,
      baseScore: 0.25,
      learningRate: 0.5,
      trees: [
        {
          feature: [0, -2, -2],
          threshold: [1.5, 0, 0],
          left: [1, -1, -1],
          right: [2, -1, -1],
          value: [0, 4, 8],
        },
      ],
    }
    expect(rawScore(ensemble, [1])).toBeCloseTo(0.25 + 0.5 * 4, 12)
    expect(rawScore(ensemble, [2])).toBeCloseTo(0.25 + 0.5 * 8, 12)
  })

  it('refuses a tree that does not descend rather than looping', () => {
    const cyclic = {
      kind: 'tree_ensemble' as const,
      baseScore: 0,
      learningRate: 1,
      trees: [{ feature: [0], threshold: [0.5], left: [0], right: [0], value: [0] }],
    }
    expect(() => rawScore(cyclic, [0])).toThrow(ScorerError)
  })

  it('reports the widest feature index a scorer reads', () => {
    expect(scorerWidth(linear)).toBe(2)
  })

  it('keeps sigmoid stable at both extremes', () => {
    expect(sigmoid(-800)).toBe(0)
    expect(sigmoid(800)).toBe(1)
    expect(sigmoid(0)).toBeCloseTo(0.5, 12)
  })
})

describe('uplift model contract', () => {
  const committed = JSON.parse(readFileSync('./fixtures/uplift-model.json', 'utf8')) as Record<
    string,
    unknown
  >

  it('parses the committed model that the engine actually serves', () => {
    const model = parseUpliftModel(committed)
    expect(model.featureNames).toEqual([...FEATURE_NAMES])
    expect(model.metrics.rows).toBeGreaterThan(0)
    expect(model.provenance.candidates.filter((entry) => entry.selected)).toHaveLength(1)
  })

  it('predicts exactly zero uplift for doing nothing', () => {
    const model = parseUpliftModel(committed)
    expect(predictUplift(model, caseFeatures(), BASELINE_ACTION)).toBe(0)
  })

  it('separates cases rather than returning one constant', () => {
    const model = parseUpliftModel(committed)
    const values = [
      predictUplift(model, caseFeatures({ touchCount: 0, daysSinceDue: 1 }), NUDGE),
      predictUplift(model, caseFeatures({ touchCount: 6, daysSinceDue: 40 }), NUDGE),
      predictUplift(model, caseFeatures({ failureClass: 'INSTRUMENT_INVALID' }), NUDGE),
    ]
    expect(new Set(values).size).toBeGreaterThan(1)
  })

  it('rejects a model whose feature names have drifted', () => {
    expect(() =>
      parseUpliftModel({ ...committed, featureNames: [...FEATURE_NAMES].reverse() }),
    ).toThrow(UpliftModelError)
  })

  it('rejects a model with the wrong number of features', () => {
    expect(() => parseUpliftModel({ ...committed, featureNames: ['only_one'] })).toThrow(
      UpliftModelError,
    )
  })

  it('rejects a payload that is not a model at all', () => {
    expect(() => parseUpliftModel({ version: 'v1' })).toThrow(UpliftModelError)
  })

  it('scores the golden vectors exactly as the Python trainer did', () => {
    const model = parseUpliftModel(committed)
    const golden = JSON.parse(readFileSync('./fixtures/uplift-golden.json', 'utf8')) as {
      modelVersion: string
      rows: number[][]
      expected: Record<string, number[]>
    }

    expect(golden.modelVersion).toBe(model.version)
    expect(model.estimator).toBe('outcome_difference')
    if (model.estimator !== 'outcome_difference') return

    const expected = golden.expected['scorer']
    expect(expected).toBeDefined()

    for (const [index, row] of golden.rows.entries()) {
      expect(rawScore(model.scorer, row)).toBeCloseTo(expected?.[index] ?? Number.NaN, 12)
    }
  })
})
