import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'

import { paise, type Paise } from '../core/money'
import type { Clock } from '../core/clock'
import type { ActionType, Channel, FailureClass, PaymentMethod } from '../domain/enums'
import type { Database } from '../db/client'
import {
  actions,
  consentRecords,
  contactEvents,
  customers,
  diagnoses,
  promises,
  riskCases,
  type Customer,
  type RiskCase,
} from '../db/schema'
import { type LedgerRepository } from '../ledger/ledger'
import type { ConsentView, DraftContent, PolicyContext } from '../policy/context'
import { rungIndexOf } from '../policy/escalation'
import type { StopContext } from '../policy/stop-gate'

const DAY_MS = 86_400_000

export interface WorldFacts {
  readonly bankHolidays: ReadonlySet<string>
  readonly pausedCohorts: ReadonlySet<string>
  readonly killSwitchEngaged: boolean
  readonly merchantPaused: boolean
  isFestival(at: number): boolean
}

export interface CaseView {
  readonly row: RiskCase
  readonly customer: Customer
  readonly outstandingPaise: Paise
  readonly billedPaise: Paise
  readonly failureClass: FailureClass
  readonly instrumentMethod: PaymentMethod | undefined
  readonly issuer: string | undefined
  readonly consents: Readonly<Partial<Record<Channel, ConsentView>>>
  readonly touchesByChannel24h: Readonly<Partial<Record<Channel, number>>>
  readonly touchesCase7d: number
  readonly touchesCustomer7d: number
  readonly lastTouchAt: number | undefined
  readonly lastInboundAt: number | undefined
  readonly rungReached: number
  readonly lastRungChangeAt: number | undefined
  readonly preDebitNoticeSentAt: number | undefined
  readonly cardAttempts30d: number
  readonly retriesExcludingInfra: number
  readonly hasActivePromise: boolean
  readonly priorCasesResolved: number
  readonly priorCasesRecovered: number
  readonly promiseDueAt: number | undefined
  readonly caseAgeDays: number
  readonly cohortPaused: boolean
  readonly mandateCapPaise: Paise | undefined
}

const PREFETCH_CHUNK = 400

export class ContextBuilder {
  private readonly db: Database
  private readonly clock: Clock
  private readonly ledger: LedgerRepository
  private readonly facts: () => WorldFacts
  private cases = new Map<string, RiskCase>()
  private people = new Map<string, Customer>()

  constructor(db: Database, clock: Clock, ledger: LedgerRepository, facts: () => WorldFacts) {
    this.db = db
    this.clock = clock
    this.ledger = ledger
    this.facts = facts
  }

  async prefetch(caseIds: readonly string[]): Promise<void> {
    this.cases = new Map()
    this.people = new Map()
    if (caseIds.length === 0) return

    for (let i = 0; i < caseIds.length; i += PREFETCH_CHUNK) {
      const chunk = caseIds.slice(i, i + PREFETCH_CHUNK)
      const rows = await this.db.select().from(riskCases).where(inArray(riskCases.id, chunk))
      for (const row of rows) this.cases.set(row.id, row)

      const customerIds = [...new Set(rows.map((row) => row.customerId))]
      if (customerIds.length === 0) continue
      const people = await this.db
        .select()
        .from(customers)
        .where(inArray(customers.id, customerIds))
      for (const person of people) this.people.set(person.id, person)
    }
  }

  release(): void {
    this.cases = new Map()
    this.people = new Map()
  }

  async load(caseId: string): Promise<CaseView | undefined> {
    const at = this.clock.now()

    const row =
      this.cases.get(caseId) ??
      (await this.db.select().from(riskCases).where(eq(riskCases.id, caseId)).limit(1))[0]
    if (row === undefined) return undefined

    const customer =
      this.people.get(row.customerId) ??
      (await this.db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1))[0]
    if (customer === undefined) return undefined

    const [outstanding, billed, consents, touches, diagnosis, history, promise, priors] =
      await Promise.all([
        this.ledger.outstanding(caseId),
        this.billedTotal(caseId),
        this.consentsFor(row.customerId, at),
        this.touchCounts(row, at),
        this.latestDiagnosis(caseId),
        this.actionHistory(caseId),
        this.activePromise(caseId),
        this.paymentHistory(row.customerId, caseId, at),
      ])

    const [method, issuer] = (row.cohortId ?? '|').split('|')

    return {
      row,
      customer,
      outstandingPaise: outstanding,
      billedPaise: billed,
      failureClass: diagnosis?.failureClass ?? 'AMBIGUOUS',
      instrumentMethod: method === '' ? undefined : (method as PaymentMethod),
      issuer: issuer === '' || issuer === 'unknown' ? undefined : issuer,
      consents,
      touchesByChannel24h: touches.byChannel24h,
      touchesCase7d: touches.case7d,
      touchesCustomer7d: touches.customer7d,
      lastTouchAt: touches.lastTouchAt,
      lastInboundAt: touches.lastInboundAt,
      rungReached: history.rungReached,
      lastRungChangeAt: history.lastRungChangeAt,
      preDebitNoticeSentAt: history.preDebitNoticeSentAt,
      cardAttempts30d: history.cardAttempts30d,
      retriesExcludingInfra: row.attemptCount,
      hasActivePromise: promise !== undefined,
      priorCasesResolved: priors.resolved + customer.priorBillsSettled,
      priorCasesRecovered: priors.recovered + customer.priorBillsPaid,
      promiseDueAt: promise?.promisedDate,
      caseAgeDays: (at - row.firstSeenAt) / DAY_MS,
      cohortPaused: row.cohortId !== null && this.facts().pausedCohorts.has(row.cohortId),
      mandateCapPaise:
        customer.mandateCapPaise === null ? undefined : paise(customer.mandateCapPaise),
    }
  }

  policyContext(
    view: CaseView,
    action: ActionType,
    channel: Channel | undefined,
    content: DraftContent | undefined,
    extras: { discountPct?: number; extensionDays?: number; modelPayload?: string } = {},
  ): PolicyContext {
    const at = this.clock.now()
    const facts = this.facts()

    return {
      at,
      action,
      channel,
      caseId: view.row.id,
      customerId: view.row.customerId,
      outstandingPaise: view.outstandingPaise,
      caseAgeDays: view.caseAgeDays,
      disputeOpen: view.row.disputeOpenedAt !== null,
      hasActivePromise: view.hasActivePromise,
      priorCasesResolved: view.priorCasesResolved,
      priorCasesRecovered: view.priorCasesRecovered,
      optedOutGlobal: view.customer.optedOutGlobal,
      dnd: view.customer.dnd,
      erasureRequestedAt: view.customer.erasureRequestedAt ?? undefined,
      preferredLanguage: view.customer.languagePref,
      consentByChannel: view.consents,
      contactRoleAuthorised: !view.customer.contactDataSuspect,
      touchesByChannel24h: view.touchesByChannel24h,
      touchesCase7d: view.touchesCase7d,
      touchesCustomer7d: view.touchesCustomer7d,
      lastTouchAt: view.lastTouchAt,
      lastInboundAt: view.lastInboundAt,
      rungReached: view.rungReached,
      lastRungChangeAt: view.lastRungChangeAt,
      isFestival: facts.isFestival(at),
      cohortPaused: view.cohortPaused,
      instrumentMethod: view.instrumentMethod,
      mandateCapPaise: view.mandateCapPaise,
      preDebitNoticeSentAt: view.preDebitNoticeSentAt,
      cardAttempts30d: view.cardAttempts30d,
      discountPct: extras.discountPct,
      discountPaise: undefined,
      extensionDays: extras.extensionDays,
      humanApproved: false,
      content,
      modelPayload: extras.modelPayload,
    }
  }

  stopContext(view: CaseView, action: ActionType, bestRemainingEvPaise: Paise): StopContext {
    const economicStopsApply = view.row.arm !== 'CONTROL'
    const facts = this.facts()
    return {
      at: this.clock.now(),
      action,
      outstandingPaise: view.outstandingPaise,
      originalAmountPaise: view.billedPaise,
      disputeOpen: view.row.disputeOpenedAt !== null,
      invoiceDisputed: false,
      optedOut: view.customer.optedOutGlobal,
      wrongPerson: view.customer.contactDataSuspect,
      deceased: view.customer.deceased,
      distressSignalled: false,
      abuseSignalled: false,
      retriesExcludingInfra: view.retriesExcludingInfra,
      touchCount: view.row.touchCount,
      bestRemainingEvPaise,
      mandateDead: view.failureClass === 'MANDATE_BROKEN',
      riskFlagged: view.customer.riskFlagged,
      cohortPaused: view.cohortPaused,
      killSwitchEngaged: facts.killSwitchEngaged,
      merchantPaused: facts.merchantPaused,
      hasActivePromise: view.hasActivePromise,
      promiseDueAt: view.promiseDueAt,
      caseAgeDays: view.caseAgeDays,
      economicStopsApply,
    }
  }

  private async billedTotal(caseId: string): Promise<Paise> {
    const history = await this.ledger.history(caseId)
    let total = 0
    for (const event of history) if (event.type === 'CHARGE') total += event.amountPaise
    return paise(total)
  }

  private async consentsFor(
    customerId: string,
    at: number,
  ): Promise<Partial<Record<Channel, ConsentView>>> {
    const rows = await this.db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.customerId, customerId))
      .orderBy(desc(consentRecords.capturedAt))

    const result: Partial<Record<Channel, ConsentView>> = {}
    for (const row of rows) {
      if (result[row.channel] !== undefined) continue
      if (row.capturedAt > at) continue
      result[row.channel] = {
        granted: row.granted,
        purpose: row.purpose,
        revokedAt: row.revokedAt ?? undefined,
      }
    }
    return result
  }

  private async touchCounts(
    row: RiskCase,
    at: number,
  ): Promise<{
    byChannel24h: Partial<Record<Channel, number>>
    case7d: number
    customer7d: number
    lastTouchAt: number | undefined
    lastInboundAt: number | undefined
  }> {
    const since = at - 7 * DAY_MS
    const events = await this.db
      .select()
      .from(contactEvents)
      .where(and(eq(contactEvents.customerId, row.customerId), gte(contactEvents.sentAt, since)))

    const byChannel24h: Partial<Record<Channel, number>> = {}
    let case7d = 0
    let customer7d = 0
    let lastTouchAt: number | undefined
    let lastInboundAt: number | undefined

    for (const event of events) {
      if (event.sentAt > at) continue

      if (event.direction === 'INBOUND') {
        lastInboundAt =
          lastInboundAt === undefined ? event.sentAt : Math.max(lastInboundAt, event.sentAt)
        continue
      }

      customer7d++
      if (event.caseId === row.id) case7d++
      lastTouchAt = lastTouchAt === undefined ? event.sentAt : Math.max(lastTouchAt, event.sentAt)

      if (at - event.sentAt < DAY_MS) {
        byChannel24h[event.channel] = (byChannel24h[event.channel] ?? 0) + 1
      }
    }

    return { byChannel24h, case7d, customer7d, lastTouchAt, lastInboundAt }
  }

  private async latestDiagnosis(caseId: string) {
    const rows = await this.db
      .select()
      .from(diagnoses)
      .where(eq(diagnoses.caseId, caseId))
      .orderBy(desc(diagnoses.at))
      .limit(1)
    return rows[0]
  }

  private async actionHistory(caseId: string): Promise<{
    rungReached: number
    lastRungChangeAt: number | undefined
    preDebitNoticeSentAt: number | undefined
    cardAttempts30d: number
  }> {
    const at = this.clock.now()
    const rows = await this.db
      .select()
      .from(actions)
      .where(and(eq(actions.caseId, caseId), inArray(actions.status, ['SENT'])))
      .orderBy(desc(actions.executedAt))

    let rungReached = 0
    let lastRungChangeAt: number | undefined
    let preDebitNoticeSentAt: number | undefined
    let cardAttempts30d = 0

    for (const row of rows) {
      const rung = rungIndexOf(row.type)
      if (rung > rungReached) {
        rungReached = rung
        lastRungChangeAt = row.executedAt ?? undefined
      }
      if (row.type === 'SEND_PRE_DEBIT_NOTICE' && preDebitNoticeSentAt === undefined) {
        preDebitNoticeSentAt = row.executedAt ?? undefined
      }
      if (
        (row.type === 'RETRY_CHARGE' || row.type === 'RETRY_CHARGE_ALT_ROUTE') &&
        row.executedAt !== null &&
        at - row.executedAt <= 30 * DAY_MS
      ) {
        cardAttempts30d++
      }
    }

    return { rungReached, lastRungChangeAt, preDebitNoticeSentAt, cardAttempts30d }
  }

  private async paymentHistory(
    customerId: string,
    caseId: string,
    at: number,
  ): Promise<{ resolved: number; recovered: number }> {
    const rows = await this.db
      .select({ id: riskCases.id, state: riskCases.state, resolvedAt: riskCases.resolvedAt })
      .from(riskCases)
      .where(and(eq(riskCases.customerId, customerId), lt(riskCases.resolvedAt, at)))

    const settled = rows.filter((row) => row.id !== caseId && row.resolvedAt !== null)

    return {
      resolved: settled.length,
      recovered: settled.filter((row) => row.state === 'RECOVERED').length,
    }
  }

  private async activePromise(caseId: string) {
    const rows = await this.db
      .select()
      .from(promises)
      .where(and(eq(promises.caseId, caseId), eq(promises.status, 'ACTIVE')))
      .orderBy(desc(promises.createdAt))
      .limit(1)
    return rows[0]
  }
}
