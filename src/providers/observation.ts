import { paise } from '../core/money'
import type { Channel } from '../domain/enums'
import type {
  ChargeRequest,
  ChargeResult,
  MessageSender,
  PaymentExecutor,
  SendRequest,
  SendResult,
} from './port'

export class ObservationPaymentExecutor implements PaymentExecutor {
  readonly name = 'observation-only'

  charge(_request: ChargeRequest): Promise<ChargeResult> {
    return Promise.resolve({
      attempted: false,
      succeeded: false,
      providerRef: undefined,
      failure: undefined,
      costPaise: paise(0),
      retryable: false,
    })
  }
}

class ObservationMessageSender implements MessageSender {
  readonly name: string

  constructor(channel: Channel) {
    this.name = `observation-${channel.toLowerCase()}`
  }

  send(_request: SendRequest): Promise<SendResult> {
    return Promise.resolve({
      attempted: false,
      accepted: false,
      providerRef: undefined,
      costPaise: paise(0),
      failureReason: 'observation mode: nothing was sent',
      retryable: false,
    })
  }
}

export function observationSenders(): ReadonlyMap<Channel, MessageSender> {
  const channels: Channel[] = ['SMS', 'WHATSAPP', 'EMAIL', 'VOICE']
  return new Map(channels.map((channel) => [channel, new ObservationMessageSender(channel)]))
}
