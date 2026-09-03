import { paise, type Paise } from '../core/money'
import type { Channel } from '../domain/enums'
import { classifyError } from '../providers/gateway/failure-mapping'
import type {
  ChargeRequest,
  ChargeResult,
  MessageSender,
  PaymentExecutor,
  SendRequest,
  SendResult,
} from '../providers/port'
import { signaturesFor } from './error-signatures'
import type { Simulator } from './simulator'

function obligationOf(caseId: string): string {
  return caseId.startsWith('case_') ? caseId.slice('case_'.length) : caseId
}

export interface ChannelCosts {
  costFor(channel: Channel): Paise
}

export class SimulatedPaymentExecutor implements PaymentExecutor {
  readonly name = 'simulated-gateway'
  private readonly simulator: Simulator
  private readonly seen = new Map<string, ChargeResult>()

  constructor(simulator: Simulator) {
    this.simulator = simulator
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const cached = this.seen.get(request.idempotencyKey)
    if (cached !== undefined) return cached

    if (request.dryRun) {
      const suppressed: ChargeResult = {
        attempted: false,
        succeeded: false,
        providerRef: undefined,
        failure: undefined,
        costPaise: paise(0),
        retryable: false,
      }
      this.seen.set(request.idempotencyKey, suppressed)
      return suppressed
    }

    const attempt = await this.simulator.retry(obligationOf(request.caseId), request.at)

    const signature = attempt.cause === null ? undefined : signaturesFor(attempt.cause)[0]

    const result: ChargeResult = {
      attempted: true,
      succeeded: attempt.succeeded,
      providerRef: `simpay_${request.idempotencyKey.slice(0, 12)}`,
      failure:
        signature === undefined
          ? undefined
          : classifyError({
              code: signature.code,
              source: signature.source,
              step: signature.step,
              reason: signature.reason,
            }),
      costPaise: paise(0),
      retryable: false,
    }

    this.seen.set(request.idempotencyKey, result)
    return result
  }
}

export class SimulatedMessageSender implements MessageSender {
  readonly name: string
  private readonly channel: Channel
  private readonly simulator: Simulator
  private readonly costs: ChannelCosts
  private readonly seen = new Map<string, SendResult>()

  constructor(channel: Channel, simulator: Simulator, costs: ChannelCosts) {
    this.name = `simulated-${channel.toLowerCase()}`
    this.channel = channel
    this.simulator = simulator
    this.costs = costs
  }

  async send(request: SendRequest): Promise<SendResult> {
    const cached = this.seen.get(request.idempotencyKey)
    if (cached !== undefined) return cached

    if (request.dryRun) {
      const suppressed: SendResult = {
        attempted: false,
        accepted: false,
        providerRef: undefined,
        costPaise: paise(0),
        failureReason: undefined,
        retryable: false,
      }
      this.seen.set(request.idempotencyKey, suppressed)
      return suppressed
    }

    const outcome = await this.simulator.applyAction(
      obligationOf(request.caseId),
      request.actionType,
      this.channel,
      request.at,
    )

    const reply = outcome.replied
      ? this.simulator.composeReply(obligationOf(request.caseId), request.at)
      : undefined

    const result: SendResult = {
      attempted: true,
      accepted: true,
      optedOut: outcome.optedOut,
      ...(reply === undefined ? {} : { replyBody: reply }),
      providerRef: `simmsg_${request.idempotencyKey.slice(0, 12)}`,
      costPaise: this.costs.costFor(this.channel),
      failureReason: undefined,
      retryable: false,
    }

    this.seen.set(request.idempotencyKey, result)
    return result
  }
}
