import { and, eq } from 'drizzle-orm'

import type { Clock } from '../core/clock'
import type { IdFactory } from '../core/identifiers'
import type { Logger } from '../core/logger'
import { paise, subP, type Paise } from '../core/money'
import type { CaseType, FailureClass } from '../domain/enums'
import type { Database } from '../db/client'
import { customers, diagnoses, riskCases, type RiskCase } from '../db/schema'
import { type StratifiedAssigner, stratumKey } from '../experiment/arm'
import { LedgerRepository } from '../ledger/ledger'
import { detectTdsShortfall } from '../ledger/tds'
import type { RiskSignal } from '../providers/port'

const CASE_TYPE_BY_ENTITY = (signal: RiskSignal): CaseType => {
  if (signal.kind === 'CHECKOUT_ABANDONED') return 'CHECKOUT_ABANDONED'
  if (signal.entity.invoiceId !== undefined) return 'INVOICE_OVERDUE'
  if (signal.entity.subscriptionId !== undefined) return 'SUBSCRIPTION_DUNNING'
  return 'FAILED_PAYMENT'
}

export interface ProjectionResult {
  readonly caseId: string | undefined
  readonly created: boolean
  readonly outstandingPaise: Paise
  readonly state: RiskCase['state']
  readonly tdsRecognised: boolean
}

export interface ProjectorOptions {
  readonly db: Database
  readonly clock: Clock
  readonly ids: IdFactory
  readonly logger: Logger
  readonly merchantId: string
  readonly assigner: StratifiedAssigner
  readonly policyVersion: string
}

const IGNORED: ProjectionResult = {
  caseId: undefined,
  created: false,
  outstandingPaise: paise(0),
  state: 'OPEN',
  tdsRecognised: false,
}

export class CaseProjector {
  private readonly db: Database
  private readonly clock: Clock
  private readonly ids: IdFactory
  private readonly logger: Logger
  private readonly merchantId: string
  private readonly assigner: StratifiedAssigner
  private readonly policyVersion: string
  private readonly ledger: LedgerRepository

  constructor(options: ProjectorOptions) {
    this.db = options.db
    this.clock = options.clock
    this.ids = options.ids
    this.logger = options.logger
    this.merchantId = options.merchantId
    this.assigner = options.assigner
    this.policyVersion = options.policyVersion
    this.ledger = new LedgerRepository(options.db, options.ids)
  }

  async project(signal: RiskSignal): Promise<ProjectionResult> {
    if (signal.kind === 'DOWNTIME_STARTED' || signal.kind === 'DOWNTIME_RESOLVED') return IGNORED
    if (signal.customerRef === undefined) return IGNORED

    const reference = this.referenceOf(signal)
    if (reference === undefined) return IGNORED

    const customerId = await this.ensureCustomer(signal.customerRef)
    const { row, created } = await this.ensureCase(signal, reference, customerId)
    if (row === undefined) return IGNORED

    await this.applySignal(signal, row)
    return this.settle(row, created)
  }

  private referenceOf(signal: RiskSignal): string | undefined {
    return (
      signal.obligationRef ??
      signal.entity.invoiceId ??
      signal.entity.subscriptionId ??
      signal.entity.orderId ??
      signal.entity.paymentId
    )
  }

  private async ensureCustomer(externalRef: string): Promise<string> {
    const existing = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.merchantId, this.merchantId), eq(customers.externalRef, externalRef)))
      .limit(1)

    const found = existing[0]
    if (found !== undefined) return found.id

    const id = this.ids.next('cust')
    await this.db.insert(customers).values({
      id,
      merchantId: this.merchantId,
      externalRef,
      portfolio: 'one_time_checkout',
      createdAt: this.clock.now(),
    })

    this.logger.info('customer_discovered_from_webhook', { customerId: id })
    return id
  }

  private async ensureCase(
    signal: RiskSignal,
    reference: string,
    customerId: string,
  ): Promise<{ row: RiskCase | undefined; created: boolean }> {
    const existing = await this.db
      .select()
      .from(riskCases)
      .where(
        and(eq(riskCases.merchantId, this.merchantId), eq(riskCases.id, this.caseIdFor(reference))),
      )
      .limit(1)

    const found = existing[0]
    if (found !== undefined) return { row: found, created: false }

    const amount = signal.amountPaise ?? paise(0)
    if (amount <= 0) {
      this.logger.debug('signal_cannot_open_case', { reference, kind: signal.kind })
      return { row: undefined, created: false }
    }

    const failureClass: FailureClass | 'UNKNOWN' =
      signal.error?.failureClass ??
      (signal.kind === 'CHECKOUT_ABANDONED' ? 'AUTH_DROPOFF' : 'UNKNOWN')
    const now = this.clock.now()
    const stratum = stratumKey(amount, failureClass)

    const row: RiskCase = {
      id: this.caseIdFor(reference),
      merchantId: this.merchantId,
      customerId,
      type: CASE_TYPE_BY_ENTITY(signal),
      amountPaise: amount,
      currency: 'INR',
      dueAt: signal.occurredAt,
      sourceEntity: signal.entity,
      state: 'OPEN',
      stopReason: null,
      arm: this.assigner.assign(stratum, reference),
      stratum,
      cohortId:
        signal.method === undefined ? null : `${signal.method}|${signal.issuer ?? 'unknown'}`,
      disputeOpenedAt: null,
      attemptCount: 0,
      touchCount: 0,
      recoveredPaise: 0,
      costPaise: 0,
      policyVersion: this.policyVersion,
      firstSeenAt: signal.occurredAt,
      nextDecisionAt: signal.occurredAt,
      resolvedAt: null,
      updatedAt: now,
    }

    await this.db.insert(riskCases).values(row)
    await this.ledger.append({
      caseId: row.id,
      merchantId: this.merchantId,
      type: 'CHARGE',
      amountPaise: amount,
      at: signal.occurredAt,
      ref: reference,
    })

    this.logger.info('case_opened', { caseId: row.id, arm: row.arm, stratum })
    return { row, created: true }
  }

  private caseIdFor(reference: string): string {
    return `case_${reference}`
  }

  private async applySignal(signal: RiskSignal, row: RiskCase): Promise<void> {
    if (signal.amountPaise !== undefined && signal.amountPaise > row.amountPaise) {
      const delta = subP(signal.amountPaise, paise(row.amountPaise))
      await this.ledger.append({
        caseId: row.id,
        merchantId: this.merchantId,
        type: 'CHARGE',
        amountPaise: delta,
        at: signal.occurredAt,
        ref: 'billed_total_adjustment',
      })
      await this.db
        .update(riskCases)
        .set({ amountPaise: signal.amountPaise, updatedAt: this.clock.now() })
        .where(eq(riskCases.id, row.id))
    }

    switch (signal.kind) {
      case 'PAYMENT_FAILED':
        await this.recordFailure(signal, row)
        return

      case 'PAYMENT_SUCCEEDED':
      case 'SUBSCRIPTION_CHARGED': {
        const amount = signal.amountPaise
        const providerRef = signal.entity.paymentId
        if (amount === undefined || providerRef === undefined) return
        await this.ledger.append({
          caseId: row.id,
          merchantId: this.merchantId,
          type: 'PAYMENT',
          amountPaise: amount,
          at: signal.occurredAt,
          providerRef,
        })
        return
      }

      case 'REFUND_PROCESSED': {
        const amount = signal.amountPaise
        const providerRef = signal.entity.paymentId
        if (amount === undefined || providerRef === undefined) return
        await this.ledger.append({
          caseId: row.id,
          merchantId: this.merchantId,
          type: 'REFUND',
          amountPaise: amount,
          at: signal.occurredAt,
          providerRef: `refund_${providerRef}`,
        })
        return
      }

      case 'CHECKOUT_ABANDONED':
      case 'INVOICE_PAID':
      case 'INVOICE_PARTIALLY_PAID':
      case 'SUBSCRIPTION_HALTED':
      case 'SUBSCRIPTION_CANCELLED':
      case 'DOWNTIME_STARTED':
      case 'DOWNTIME_RESOLVED':
        return
    }
  }

  private async recordFailure(signal: RiskSignal, row: RiskCase): Promise<void> {
    const error = signal.error
    if (error === undefined) return

    await this.db.insert(diagnoses).values({
      id: this.ids.next('diag'),
      caseId: row.id,
      failureClass: error.failureClass,
      confidence: error.confidence,
      evidence: [
        { field: 'source', value: error.source },
        { field: 'step', value: error.step },
        { field: 'reason', value: error.reason },
        { field: 'rule_id', value: error.ruleId },
      ],
      signature: {
        source: error.source,
        step: error.step,
        reason: error.reason,
        ...(signal.method === undefined ? {} : { method: signal.method }),
        ...(signal.issuer === undefined ? {} : { issuer: signal.issuer }),
      },
      attributedTo: error.attributedTo,
      cohortId: row.cohortId,
      method: 'TABLE',
      modelUsed: false,
      modelVersion: null,
      at: signal.occurredAt,
    })

    if (error.countsAgainstAttemptBudget) {
      await this.db
        .update(riskCases)
        .set({ attemptCount: row.attemptCount + 1, updatedAt: this.clock.now() })
        .where(eq(riskCases.id, row.id))
    }
  }

  private async settle(row: RiskCase, created: boolean): Promise<ProjectionResult> {
    let outstanding = await this.ledger.outstanding(row.id)
    let tdsRecognised = false

    if (outstanding > 0 && row.type === 'INVOICE_OVERDUE') {
      const paid = await this.ledger.totalPaidAsOf(row.id, this.clock.now())
      const billed = await this.billedTotal(row.id)
      if (paid > 0) {
        const match = detectTdsShortfall(billed, paid, { gstRatesPct: [0] })
        if (match !== null) {
          await this.ledger.append({
            caseId: row.id,
            merchantId: this.merchantId,
            type: 'TDS_ADJUSTMENT',
            amountPaise: match.expectedDeductionPaise,
            at: this.clock.now(),
            ref: `tds_${match.section}`,
          })
          outstanding = await this.ledger.outstanding(row.id)
          tdsRecognised = true
          this.logger.info('tds_recognised', {
            caseId: row.id,
            section: match.section,
            ratePct: match.ratePct,
          })
        }
      }
    }

    const recovered = outstanding <= 0
    const now = this.clock.now()

    if (recovered && row.state !== 'RECOVERED') {
      const paid = await this.ledger.totalPaidAsOf(row.id, now)
      await this.db
        .update(riskCases)
        .set({
          state: 'RECOVERED',
          resolvedAt: now,
          recoveredPaise: paid,
          updatedAt: now,
        })
        .where(eq(riskCases.id, row.id))
    } else if (!recovered && row.state === 'RECOVERED') {
      await this.db
        .update(riskCases)
        .set({ state: 'IN_PROGRESS', resolvedAt: null, updatedAt: now })
        .where(eq(riskCases.id, row.id))
    }

    return {
      caseId: row.id,
      created,
      outstandingPaise: outstanding,
      state: recovered ? 'RECOVERED' : row.state,
      tdsRecognised,
    }
  }

  private async billedTotal(caseId: string): Promise<Paise> {
    const history = await this.ledger.history(caseId)
    let total = 0
    for (const event of history) {
      if (event.type === 'CHARGE') total += event.amountPaise
    }
    return paise(total)
  }
}
