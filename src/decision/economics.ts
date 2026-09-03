import { paise, type Paise } from '../core/money'
import type { CostsConfig } from '../core/config-files'
import type { ActionType, Channel } from '../domain/enums'

export interface CostBreakdown {
  readonly directPaise: Paise
  readonly annoyancePaise: Paise
  readonly riskPaise: Paise
  readonly totalPaise: Paise
}

export interface ValuedAction {
  readonly grossPaise: Paise
  readonly cost: CostBreakdown
  readonly evPaise: Paise
}

export interface ScoringInputs {
  readonly action: ActionType
  readonly channel: Channel | undefined
  readonly uplift: number
  readonly outstandingPaise: Paise
  readonly touchCount: number
}

export function costOf(
  action: ActionType,
  channel: Channel | undefined,
  touchCount: number,
  costs: CostsConfig,
): CostBreakdown {
  const actionCost = costs.actions[action]
  const channelCost = channel === undefined ? undefined : costs.channels[channel]

  const direct = (actionCost?.direct_paise ?? 0) + (channelCost?.direct_paise ?? 0)
  const risk = (actionCost?.risk_paise ?? 0) + (channelCost?.risk_paise ?? 0)

  const annoyanceBase = channelCost?.annoyance_paise ?? 0
  const annoyance = Math.round(
    annoyanceBase * Math.pow(costs.annoyance_growth_per_touch, touchCount),
  )

  return {
    directPaise: paise(direct),
    annoyancePaise: paise(annoyance),
    riskPaise: paise(risk),
    totalPaise: paise(direct + annoyance + risk),
  }
}

export function valueOf(inputs: ScoringInputs, costs: CostsConfig): ValuedAction {
  if (!Number.isFinite(inputs.uplift)) {
    throw new RangeError(`uplift must be finite, got ${inputs.uplift}`)
  }

  const cost = costOf(inputs.action, inputs.channel, inputs.touchCount, costs)
  const gross = Math.round(
    (inputs.uplift * inputs.outstandingPaise * costs.margin_rate_bp) / 10_000,
  )

  return {
    grossPaise: paise(gross),
    cost,
    evPaise: paise(gross - cost.totalPaise),
  }
}
