import type { ActionType, Channel } from '../domain/enums'

const HOUR_MS = 3_600_000

export interface ControlInputs {
  readonly at: number
  readonly firstSeenAt: number
  readonly attemptCount: number
  readonly touchCount: number
}

export interface ControlChoice {
  readonly action: ActionType
  readonly channel: Channel | undefined
  readonly rationale: string
}

const RETRY_OFFSETS_HOURS = [24, 48, 72]

export function controlAction(inputs: ControlInputs): ControlChoice {
  const elapsedHours = (inputs.at - inputs.firstSeenAt) / HOUR_MS
  const nextOffset = RETRY_OFFSETS_HOURS[inputs.attemptCount]

  if (nextOffset !== undefined && elapsedHours >= nextOffset) {
    return {
      action: 'RETRY_CHARGE',
      channel: undefined,
      rationale: `fixed schedule retry at T+${nextOffset}h`,
    }
  }

  if (inputs.attemptCount >= 1 && inputs.touchCount === 0) {
    return {
      action: 'SEND_NUDGE',
      channel: 'SMS',
      rationale: 'one generic SMS after the first failure',
    }
  }

  if (inputs.attemptCount >= 3 && inputs.touchCount === 1) {
    return {
      action: 'SEND_NUDGE',
      channel: 'EMAIL',
      rationale: 'one email after the third failure',
    }
  }

  return { action: 'WAIT', channel: undefined, rationale: 'nothing due on the fixed schedule' }
}
