import type { VirtualClock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import { paise, type Paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import type { ActionType, Channel, PaymentMethod } from '../domain/enums'
import type { GatewayEvent } from '../providers/gateway/webhook-schema'
import { SIM_FAILURE_CAUSES, signaturesFor, type SimFailureCause } from './error-signatures'
import { GatewayEventEmitter } from './events'
import { attemptCharge, type ChargeAttemptResult } from './hidden/charge'
import { registerContact, sampleOutcome, type SampledOutcome } from './hidden/outcome'
import type { OutcomeContext } from './hidden/outcome'
import type { SimAccount, SimObligation } from './population'
import { downtimeSeverity, worldStateAt, type WorldTimeline } from './world'

const DAY_MS = 86_400_000
const SUBSCRIPTION_HALT_AFTER_ATTEMPTS = 3
const CHECKOUT_ABANDONMENT_RATE = 0.35

export interface SimulationSink {
  deliver(event: GatewayEvent, at: number): void | Promise<void>
}

export interface TrafficAttempt {
  readonly at: number
  readonly method: PaymentMethod
  readonly issuer: string
  readonly succeeded: boolean
  readonly amountPaise: Paise
}

export interface BackgroundTraffic {
  readonly attemptsPerHour: number
  readonly cohorts: readonly (readonly [PaymentMethod, string, number])[]
  readonly baseSuccessRate: number
  onAttempt(attempt: TrafficAttempt): void
}

export interface SimulatorOptions {
  readonly merchantId: string
  readonly accounts: readonly SimAccount[]
  readonly timeline: WorldTimeline
  readonly clock: VirtualClock
  readonly rng: Rng
  readonly ids: IdFactory
  readonly sink: SimulationSink
  readonly accountId?: string
  readonly backgroundTraffic?: BackgroundTraffic
}

export interface SimulationStats {
  readonly obligationsDue: number
  readonly chargeAttempts: number
  readonly chargeSuccesses: number
  readonly chargeFailures: number
  readonly failuresByCause: Readonly<Record<SimFailureCause, number>>
  readonly eventsEmitted: number
  readonly downtimeWindows: number
  readonly subscriptionsHalted: number
  readonly checkoutsAbandoned: number
  readonly partialPayments: number
  readonly grossDuePaise: Paise
  readonly grossCapturedPaise: Paise
}

const REPLIES = {
  OPT_OUT: ['STOP messaging me', 'Please unsubscribe me from these messages', 'Do not contact me'],
  DISPUTE: [
    'This is the wrong amount, I was overcharged',
    'I never subscribed to this service, please refund',
    'Already cancelled this last month, why the bill',
  ],
  PROMISE: [
    'I will pay next week after salary',
    'Will pay by tomorrow, please wait',
    'Paying in 3 days, kal nahi ho paya',
  ],
  CANNOT_PAY: [
    'I cannot pay right now, no money this month',
    'Can I pay in instalments instead?',
    'Unable to pay, please give me a plan',
  ],
  ALREADY_PAID: [
    'Already paid this yesterday, UTR is with me',
    'Payment done, please check your records',
  ],
  DISTRESS: [
    'I lost my job last month, please give me time',
    'Family medical emergency, hospital bills first',
  ],
} as const

interface ObligationState {
  readonly account: SimAccount
  readonly obligation: SimObligation
  readonly chargeRng: Rng
  readonly actionRng: Rng
  readonly signatureRng: Rng
  attempts: number
  touches: number
  settledPaise: number
  resolved: boolean
  halted: boolean
  abandoned: boolean
}

export class Simulator {
  private readonly options: SimulatorOptions
  private readonly emitter: GatewayEventEmitter
  private readonly states = new Map<string, ObligationState>()

  private obligationsDue = 0
  private chargeAttempts = 0
  private chargeSuccesses = 0
  private checkoutsAbandoned = 0
  private chargeFailures = 0
  private eventsEmitted = 0
  private downtimeWindows = 0
  private subscriptionsHalted = 0
  private partialPayments = 0
  private grossDuePaise = 0
  private grossCapturedPaise = 0

  private readonly failuresByCause = new Map<SimFailureCause, number>()

  constructor(options: SimulatorOptions) {
    this.options = options
    this.emitter = new GatewayEventEmitter(options.ids, options.accountId ?? 'acc_simulation')
    for (const account of options.accounts) {
      for (const obligation of account.obligations) {
        const stream = options.rng.derive(`obligation:${obligation.id}`)
        this.states.set(obligation.id, {
          account,
          obligation,
          chargeRng: stream.derive('charge'),
          actionRng: stream.derive('action'),
          signatureRng: stream.derive('signature'),
          attempts: 0,
          touches: 0,
          settledPaise: 0,
          resolved: false,
          halted: false,
          abandoned: false,
        })
      }
    }
  }

  private scheduleBackgroundTraffic(): void {
    const traffic = this.options.backgroundTraffic
    if (traffic === undefined || traffic.attemptsPerHour <= 0) return

    const { clock, timeline } = this.options
    const trafficRng = this.options.rng.derive('background-traffic')
    const weights = traffic.cohorts.map(
      ([method, issuer, weight]) => [`${method}|${issuer}`, weight] as const,
    )

    for (let at = timeline.startAt; at < timeline.endAt; at += 3_600_000) {
      const hourStart = at
      clock.schedule(
        hourStart,
        () => {
          for (let i = 0; i < traffic.attemptsPerHour; i++) {
            const [method, issuer] = trafficRng.weighted(weights).split('|') as [
              PaymentMethod,
              string,
            ]
            const at2 = hourStart + Math.floor((i / traffic.attemptsPerHour) * 3_600_000)
            const severity = downtimeSeverity(worldStateAt(timeline, at2), method, issuer)
            const succeeded = trafficRng.bool(traffic.baseSuccessRate * (1 - severity))
            traffic.onAttempt({
              at: at2,
              method,
              issuer,
              succeeded,
              amountPaise: paise(trafficRng.int(20_000, 500_000)),
            })
          }
        },
        'background-traffic',
      )
    }
  }

  schedule(): void {
    this.scheduleBackgroundTraffic()
    const { clock, timeline } = this.options

    for (const state of this.states.values()) {
      const dueAt = state.obligation.dueAt
      if (dueAt < clock.now() || dueAt >= timeline.endAt) continue
      clock.schedule(dueAt, () => this.onObligationDue(state.obligation.id), 'obligation-due')
    }

    for (const event of timeline.events) {
      if (event.kind !== 'gateway_downtime' || event.method === undefined) continue
      this.downtimeWindows++
      const downtimeId = this.emitter.nextDowntimeId()
      const method = event.method
      const issuer = event.issuer ?? null
      const severity = event.severity >= 0.85 ? 'high' : event.severity >= 0.5 ? 'medium' : 'low'

      clock.schedule(
        event.startAt,
        () =>
          this.emit(
            this.emitter.downtime('payment.downtime.started', {
              downtimeId,
              method,
              issuer,
              begin: event.startAt,
              end: null,
              severity,
              at: event.startAt,
            }),
            event.startAt,
          ),
        'downtime-started',
      )

      clock.schedule(
        event.endAt,
        () =>
          this.emit(
            this.emitter.downtime('payment.downtime.resolved', {
              downtimeId,
              method,
              issuer,
              begin: event.startAt,
              end: event.endAt,
              severity,
              at: event.endAt,
            }),
            event.endAt,
          ),
        'downtime-resolved',
      )
    }
  }

  async run(): Promise<SimulationStats> {
    this.schedule()
    await this.options.clock.advanceTo(this.options.timeline.endAt)
    return this.stats()
  }

  private contextFor(state: ObligationState, at: number): OutcomeContext {
    return {
      at,
      latent: state.account.latent,
      dynamic: state.account.dynamic,
      world: worldStateAt(this.options.timeline, at),
      portfolio: state.account.portfolio,
      amountPaise: paise(state.obligation.amountPaise - state.settledPaise),
      daysSinceDue: Math.max(0, (at - state.obligation.dueAt) / DAY_MS),
      touchCount: state.touches,
      attemptCount: state.attempts,
      hasActivePromise: false,
      bankHolidays: this.options.timeline.bankHolidays,
    }
  }

  private async onObligationDue(obligationId: string): Promise<void> {
    const state = this.states.get(obligationId)
    if (state === undefined) return
    this.obligationsDue++
    this.grossDuePaise += state.obligation.amountPaise

    if (
      state.account.portfolio === 'one_time_checkout' &&
      state.chargeRng.bool(CHECKOUT_ABANDONMENT_RATE)
    ) {
      state.abandoned = true
      this.checkoutsAbandoned++
      await this.emitAbandonment(
        state,
        paise(state.obligation.amountPaise - state.settledPaise),
        state.obligation.dueAt,
      )
      return
    }

    await this.charge(state, state.obligation.dueAt)
  }

  async retry(obligationId: string, at: number): Promise<ChargeAttemptResult> {
    const state = this.requireState(obligationId)
    return this.charge(state, at)
  }

  private async charge(state: ObligationState, at: number): Promise<ChargeAttemptResult> {
    if (state.resolved || state.halted) {
      return { succeeded: false, cause: null, successProbability: 0 }
    }

    const outstanding = paise(state.obligation.amountPaise - state.settledPaise)

    const result = attemptCharge(state.chargeRng, this.contextFor(state, at), outstanding)

    state.attempts++
    this.chargeAttempts++

    if (result.succeeded) {
      await this.settle(state, outstanding, at)
      this.chargeSuccesses++
      return result
    }

    this.chargeFailures++
    if (result.cause !== null) {
      this.failuresByCause.set(result.cause, (this.failuresByCause.get(result.cause) ?? 0) + 1)
      await this.emitFailure(state, result.cause, outstanding, at)
    }

    if (
      state.account.portfolio === 'd2c_subscription' &&
      state.attempts >= SUBSCRIPTION_HALT_AFTER_ATTEMPTS
    ) {
      state.halted = true
      this.subscriptionsHalted++
      await this.emitSubscription(state, 'subscription.halted', 'halted', at)
    }

    return result
  }

  private async emitAbandonment(state: ObligationState, amount: Paise, at: number): Promise<void> {
    const { account, obligation } = state

    await this.emit(
      this.emitter.orderAbandoned({
        orderId: obligation.orderId ?? obligation.id,
        amountPaise: amount,
        attempts: state.attempts,
        method: obligation.method,
        customerId: account.id,
        createdAt: obligation.dueAt,
        at,
        notes: { obligation_id: obligation.id, customer_ref: account.externalRef },
      }),
      at,
    )
  }

  private async emitFailure(
    state: ObligationState,
    cause: SimFailureCause,
    amount: Paise,
    at: number,
  ): Promise<void> {
    const signature = state.signatureRng.pick(signaturesFor(cause))
    const { account, obligation } = state

    await this.emit(
      this.emitter.paymentFailed({
        paymentId: this.emitter.nextPaymentId(),
        orderId: obligation.orderId ?? null,
        invoiceId: obligation.invoiceId ?? null,
        amountPaise: amount,
        method: obligation.method,
        issuer: obligation.issuer,
        vpa: obligation.method === 'upi' ? `${account.externalRef}@okbank` : null,
        signature,
        at,
        notes: { obligation_id: obligation.id, customer_ref: account.externalRef },
      }),
      at,
    )
  }

  private async settle(state: ObligationState, outstanding: Paise, at: number): Promise<void> {
    const { account, obligation } = state
    const tdsRate = account.latent.tdsRatePct

    const withheld =
      account.portfolio === 'b2b_invoice' && tdsRate !== null
        ? Math.round((outstanding * tdsRate) / 100)
        : 0

    const captured = paise(outstanding - withheld)
    state.settledPaise += captured
    this.grossCapturedPaise += captured

    const fullySettled = state.settledPaise >= obligation.amountPaise
    state.resolved = fullySettled

    await this.emit(
      this.emitter.paymentCaptured({
        paymentId: this.emitter.nextPaymentId(),
        orderId: obligation.orderId ?? null,
        invoiceId: obligation.invoiceId ?? null,
        amountPaise: captured,
        method: obligation.method,
        issuer: obligation.issuer,
        at,
        notes: { obligation_id: obligation.id, customer_ref: account.externalRef },
      }),
      at,
    )

    if (obligation.invoiceId !== undefined) {
      if (!fullySettled) this.partialPayments++
      await this.emit(
        this.emitter.invoice(fullySettled ? 'invoice.paid' : 'invoice.partially_paid', {
          invoiceId: obligation.invoiceId,
          customerId: account.id,
          amountPaise: paise(obligation.amountPaise),
          amountPaidPaise: paise(state.settledPaise),
          dueBy: obligation.dueAt,
          at,
          notes: { obligation_id: obligation.id, customer_ref: account.externalRef },
        }),
        at,
      )
    }

    if (obligation.subscriptionId !== undefined && fullySettled) {
      await this.emitSubscription(state, 'subscription.charged', 'active', at)
    }
  }

  private async emitSubscription(
    state: ObligationState,
    event: 'subscription.charged' | 'subscription.halted' | 'subscription.cancelled',
    status: string,
    at: number,
  ): Promise<void> {
    const subscriptionId = state.obligation.subscriptionId
    if (subscriptionId === undefined) return

    await this.emit(
      this.emitter.subscription(event, {
        subscriptionId,
        customerId: state.account.id,
        planId: `plan_${state.account.portfolio}`,
        status,
        paidCount: state.resolved ? 1 : 0,
        totalCount: 12,
        chargeAt: null,
        at,
        notes: {
          obligation_id: state.obligation.id,
          customer_ref: state.account.externalRef,
        },
      }),
      at,
    )
  }

  async applyAction(
    obligationId: string,
    action: ActionType,
    channel: Channel | undefined,
    at: number,
  ): Promise<SampledOutcome> {
    const state = this.requireState(obligationId)
    const context = this.contextFor(state, at)
    const outcome = sampleOutcome(state.actionRng, context, action, channel)

    if (channel !== undefined) {
      state.touches++
      registerContact(state.account.dynamic, state.account.latent, channel, at)
    }

    if (outcome.optedOut) state.account.dynamic.optedOut = true
    if (outcome.cancelled) state.account.dynamic.cancelled = true

    if (outcome.paid) {
      await this.settle(state, paise(state.obligation.amountPaise - state.settledPaise), at)
    }

    return outcome
  }

  composeReply(obligationId: string, at: number): string | undefined {
    const state = this.requireState(obligationId)
    const rng = state.actionRng.derive('reply')
    const { behaviour } = state.account.latent

    if (state.account.dynamic.optedOut) return rng.pick(REPLIES.OPT_OUT)
    if (behaviour.disputesInvoice) return rng.pick(REPLIES.DISPUTE)
    if (behaviour.promisesThenBreaks) return rng.pick(REPLIES.PROMISE)
    if (state.account.latent.abilityBase < 0.3) return rng.pick(REPLIES.CANNOT_PAY)
    if (state.settledPaise > 0) return rng.pick(REPLIES.ALREADY_PAID)
    if (at - state.obligation.dueAt > 21 * 86_400_000) return rng.pick(REPLIES.DISTRESS)

    return rng.pick(REPLIES.PROMISE)
  }

  outstandingOf(obligationId: string): Paise {
    const state = this.requireState(obligationId)
    return paise(state.obligation.amountPaise - state.settledPaise)
  }

  private requireState(obligationId: string): ObligationState {
    const state = this.states.get(obligationId)
    if (state === undefined) {
      throw new RangeError(`Unknown obligation: ${obligationId}`)
    }
    return state
  }

  private async emit(event: GatewayEvent, at: number): Promise<void> {
    this.eventsEmitted++
    await this.options.sink.deliver(event, at)
  }

  stats(): SimulationStats {
    const failuresByCause = Object.fromEntries(
      SIM_FAILURE_CAUSES.map((cause) => [cause, this.failuresByCause.get(cause) ?? 0]),
    ) as Record<SimFailureCause, number>

    return {
      obligationsDue: this.obligationsDue,
      chargeAttempts: this.chargeAttempts,
      chargeSuccesses: this.chargeSuccesses,
      chargeFailures: this.chargeFailures,
      failuresByCause,
      eventsEmitted: this.eventsEmitted,
      downtimeWindows: this.downtimeWindows,
      subscriptionsHalted: this.subscriptionsHalted,
      checkoutsAbandoned: this.checkoutsAbandoned,
      partialPayments: this.partialPayments,
      grossDuePaise: paise(this.grossDuePaise),
      grossCapturedPaise: paise(this.grossCapturedPaise),
    }
  }
}

export class CollectingSink implements SimulationSink {
  readonly events: { event: GatewayEvent; at: number }[] = []

  deliver(event: GatewayEvent, at: number): void {
    this.events.push({ event, at })
  }

  ofType(type: GatewayEvent['event']): GatewayEvent[] {
    return this.events.filter((entry) => entry.event.event === type).map((entry) => entry.event)
  }
}
