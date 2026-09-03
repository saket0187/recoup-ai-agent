import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm'

import type { AuthorityConfig, CostsConfig } from '../core/config-files'
import type { Clock } from '../core/clock'
import { idempotencyKey, type IdFactory } from '../core/identifiers'
import type { Logger } from '../core/logger'
import { paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import type { TemplateRegistry } from '../content/templates'
import {
  ALL_FEATURES,
  DecisionEngine,
  type DecisionOutcome,
  type EngineFeatures,
} from '../decision/engine'
import { attemptBucketOf, dayBucketOf, hourSlotOf } from '../decision/bandit'
import type { AttributionTracker } from '../decision/feedback'
import type { ThompsonBandit } from '../decision/bandit'
import type { ActionType, Channel } from '../domain/enums'
import type { Database } from '../db/client'
import type { AuditChain } from '../db/audit-chain'
import { decisions, riskCases } from '../db/schema'
import type { PolicyEngine } from '../policy/engine'
import type { DraftContent } from '../policy/context'
import type { CaseFeatures } from '../uplift/features'
import type { UpliftModel } from '../uplift/model'
import { allocate, type AllocationRequest } from '../allocation/allocator'
import { reviewFailingClosed, type ReviewOutcome } from '../review/reviewer'
import type { CaseView, ContextBuilder } from './context-builder'

const TERMINAL_STATES = ['RECOVERED', 'STOPPED', 'WRITTEN_OFF'] as const

function decisionFeaturesOf(view: CaseView, at: number): CaseFeatures {
  return {
    outstandingPaise: view.outstandingPaise,
    failureClass: view.failureClass,
    portfolio: view.customer.portfolio,
    method: view.instrumentMethod,
    attemptCount: view.row.attemptCount,
    touchCount: view.row.touchCount,
    daysSinceDue: Math.max(0, (at - view.row.dueAt) / DAY_MS),
    at,
  }
}

const DAY_MS = 86_400_000
const DECISION_WINDOW_MS = 3_600_000

const PREFERRED_CHANNEL: Channel = 'WHATSAPP'

export interface OrchestratorOptions {
  readonly db: Database
  readonly clock: Clock
  readonly ids: IdFactory
  readonly rng: Rng
  readonly logger: Logger
  readonly merchantId: string
  readonly merchantName: string
  readonly policy: PolicyEngine
  readonly authority: AuthorityConfig
  readonly costs: CostsConfig
  readonly bandit: ThompsonBandit
  readonly templates: TemplateRegistry
  readonly contexts: ContextBuilder
  readonly audit: AuditChain
  readonly attribution: AttributionTracker
  readonly features?: EngineFeatures
  readonly upliftModel?: UpliftModel
  readonly dryRun: boolean
  enqueue(request: {
    decisionId: string
    caseId: string
    type: ActionType
    channel: Channel | undefined
    templateId: string | undefined
    language: DraftContent['language'] | undefined
    amountPaise: ReturnType<typeof paise> | undefined
    scheduledFor: number
    merchantId: string
    idempotencyKey: string
    bestRemainingEvPaise: number
    dryRun: boolean
  }): Promise<unknown>
}

export interface CycleStats {
  readonly considered: number
  readonly decided: number
  readonly scheduled: number
  readonly deferred: number
  readonly suppressed: number
  readonly reviewerBlocked: number
  readonly allocationDeferred: number
}

export class Orchestrator {
  private readonly options: OrchestratorOptions
  private readonly engine: DecisionEngine
  private readonly features: EngineFeatures
  private readonly dispatchable = new Map<
    string,
    { view: CaseView; outcome: DecisionOutcome; decisionId: string }
  >()

  constructor(options: OrchestratorOptions) {
    this.options = options
    this.features = options.features ?? ALL_FEATURES
    this.engine = new DecisionEngine({
      policy: options.policy,
      authority: options.authority,
      costs: options.costs,
      bandit: options.bandit,
      rng: options.rng,
      ...(options.features === undefined ? {} : { features: options.features }),
      ...(options.upliftModel === undefined ? {} : { upliftModel: options.upliftModel }),
    })
  }

  async dueCases(at: number, limit = 2_000): Promise<string[]> {
    const rows = await this.options.db
      .select({ id: riskCases.id })
      .from(riskCases)
      .where(
        and(
          eq(riskCases.merchantId, this.options.merchantId),
          inArray(riskCases.state, ['OPEN', 'IN_PROGRESS']),
          lte(riskCases.firstSeenAt, at),
          or(isNull(riskCases.nextDecisionAt), lte(riskCases.nextDecisionAt, at)),
        ),
      )
      .limit(limit)

    return rows.map((row) => row.id)
  }

  private nextDecisionFor(outcome: DecisionOutcome, at: number): number {
    const hour = 3_600_000
    if (outcome.finalVerdict === 'DEFER' && outcome.deferUntil !== undefined) {
      return Math.max(outcome.deferUntil, at + hour)
    }
    if (outcome.finalVerdict === 'EXECUTE') {
      return at + this.options.authority.cadence.after_execute_hours * hour
    }
    return at + this.options.authority.cadence.after_wait_hours * hour
  }

  private draftFor(view: CaseView, action: ActionType): DraftContent | undefined {
    if (!this.options.templates.has(action)) return undefined

    try {
      const rendered = this.options.templates.render(action, view.customer.languagePref, {
        amountPaise: view.outstandingPaise,
        merchantName: this.options.merchantName,
        link: `https://pay.example/${view.row.id}`,
        dueAt: view.row.dueAt,
        extensionDays:
          action === 'GRANT_EXTENSION' ? this.options.authority.extension.max_days : undefined,
      })
      return {
        body: rendered.body,
        language: rendered.language,
        amountPaise: rendered.amountPaise,
        includesOffer: rendered.includesOffer,
      }
    } catch (cause) {
      this.options.logger.warn('template_render_failed', {
        caseId: view.row.id,
        action,
        reason: cause instanceof Error ? cause.message : 'unknown',
      })
      return undefined
    }
  }

  async decideCase(
    caseId: string,
    holdForAllocation = false,
  ): Promise<DecisionOutcome | undefined> {
    const view = await this.options.contexts.load(caseId)
    if (view === undefined) return undefined
    if ((TERMINAL_STATES as readonly string[]).includes(view.row.state)) return undefined

    const at = this.options.clock.now()

    const outcome = this.engine.decide({
      at,
      caseId,
      arm: view.row.arm,
      failureClass: view.failureClass,
      outstandingPaise: view.outstandingPaise,
      originalAmountPaise: view.billedPaise,
      method: view.instrumentMethod,
      issuer: view.issuer,
      attemptCount: view.row.attemptCount,
      touchCount: view.row.touchCount,
      cohortPaused: view.cohortPaused,
      mandateCapExceeded:
        view.failureClass === 'MANDATE_BROKEN' ||
        (view.mandateCapPaise !== undefined && view.outstandingPaise > view.mandateCapPaise),
      preferredChannel: PREFERRED_CHANNEL,
      firstSeenAt: view.row.firstSeenAt,
      features: {
        failure_class: view.failureClass,
        amount_paise: view.outstandingPaise,
        attempt_count: view.row.attemptCount,
        touch_count: view.row.touchCount,
        days_since_due: Math.round(view.caseAgeDays),
        arm: view.row.arm,
        cohort: view.row.cohortId,
      },
      upliftFeatures: decisionFeaturesOf(view, at),
      policyContextFor: (action, channel) =>
        this.options.contexts.policyContext(view, action, channel, this.draftFor(view, action)),
      stopContextFor: (action, bestRemainingEvPaise) =>
        this.options.contexts.stopContext(view, action, bestRemainingEvPaise),
    })

    const review = this.reviewDraft(view, outcome)
    await this.persist(view, outcome, at, review)

    if (review?.verdict === 'BLOCK') {
      this.options.logger.warn('reviewer_blocked', {
        caseId,
        action: outcome.chosenAction,
        reason: review.reason,
      })
      return { ...outcome, finalVerdict: 'SUPPRESS', suppressReason: 'REVIEWER_BLOCK' }
    }

    if (!holdForAllocation) await this.dispatch(caseId, outcome, at)

    return outcome
  }

  private reviewDraft(view: CaseView, outcome: DecisionOutcome): ReviewOutcome | undefined {
    if (!this.features.reviewer) return undefined
    if (outcome.finalVerdict !== 'EXECUTE') return undefined

    const draft = this.draftFor(view, outcome.chosenAction)
    if (draft === undefined) return undefined

    return reviewFailingClosed({
      body: draft.body,
      language: draft.language,
      preferredLanguage: view.customer.languagePref,
      amountPaise: view.outstandingPaise,
      includesOffer: draft.includesOffer,
      offerCapPaise: paise(this.options.authority.thresholds.human_approval_required_above_paise),
    })
  }

  private async persist(
    view: CaseView,
    outcome: DecisionOutcome,
    at: number,
    review: ReviewOutcome | undefined,
  ): Promise<void> {
    const decisionId = this.options.ids.next('decision')
    const featureSnapshot = {
      failure_class: view.failureClass,
      amount_paise: view.outstandingPaise,
      attempt_count: view.row.attemptCount,
      touch_count: view.row.touchCount,
      days_since_due: Math.max(0, (at - view.row.dueAt) / DAY_MS),
      portfolio: view.customer.portfolio,
      method: view.instrumentMethod ?? null,
      arm: view.row.arm,
    }

    const record = await this.options.audit.append({
      merchantId: this.options.merchantId,
      entryType: 'DECISION',
      actor: 'engine',
      caseId: view.row.id,
      subjectId: decisionId,
      payload: {
        chosenAction: outcome.chosenAction,
        chosenChannel: outcome.chosenChannel ?? null,
        propensity: outcome.propensity,
        finalVerdict: outcome.finalVerdict,
        candidates: outcome.candidates.map((candidate) => ({
          action: candidate.action,
          channel: candidate.channel ?? null,
          pSuccess: candidate.pSuccess,
          uplift: candidate.uplift,
          evPaise: candidate.evPaise,
          costPaise: candidate.costPaise,
          rationale: candidate.rationale,
          admissible: candidate.admissible,
        })),
        featureSnapshot,
        chosenBy: outcome.chosenBy,
        modelVersion: this.options.upliftModel?.version ?? null,
        reviewerVerdict: review?.verdict ?? null,
        reviewerReason: review?.reason ?? null,
        deferUntil: outcome.deferUntil ?? null,
        suppressReason:
          review?.verdict === 'BLOCK' ? 'REVIEWER_BLOCK' : (outcome.suppressReason ?? null),
        policyVersion: outcome.policyVersion,
        playbookVersion: outcome.playbookVersion,
        policyEvaluations: outcome.policyEvaluations,
        stopEvaluations: outcome.stopEvaluations,
      },
    })

    const insertDecision = this.options.db.insert(decisions).values({
      id: decisionId,
      merchantId: this.options.merchantId,
      caseId: view.row.id,
      at,
      clockMode: 'VIRTUAL',
      featureSnapshot,
      candidates: outcome.candidates.map((candidate) => ({
        action: candidate.action,
        ...(candidate.channel === undefined ? {} : { channel: candidate.channel }),
        pSuccess: candidate.pSuccess,
        uplift: candidate.uplift,
        evPaise: candidate.evPaise,
        costPaise: candidate.costPaise,
        rationale: candidate.rationale,
      })),
      chosenAction: outcome.chosenAction,
      chosenChannel: outcome.chosenChannel ?? null,
      chosenBy: outcome.chosenBy,
      propensity: outcome.propensity,
      policyEvaluations: [...outcome.policyEvaluations],
      stopEvaluations: [...outcome.stopEvaluations],
      reviewerVerdict: review?.verdict ?? null,
      reviewerReason: review?.reason ?? null,
      finalVerdict: review?.verdict === 'BLOCK' ? 'SUPPRESS' : outcome.finalVerdict,
      deferUntil: outcome.deferUntil ?? null,
      suppressReason:
        review?.verdict === 'BLOCK' ? 'REVIEWER_BLOCK' : (outcome.suppressReason ?? null),
      policyVersion: outcome.policyVersion,
      playbookVersion: outcome.playbookVersion,
      modelVersion: this.options.upliftModel?.version ?? null,
      prevHash: record.prevHash,
      hash: record.hash,
    })

    const advanceCase = this.options.db
      .update(riskCases)
      .set({
        state: view.row.state === 'OPEN' ? 'IN_PROGRESS' : view.row.state,
        nextDecisionAt: this.nextDecisionFor(outcome, at),
        updatedAt: at,
      })
      .where(eq(riskCases.id, view.row.id))

    await this.options.db.batch([insertDecision, advanceCase])

    this.options.attribution.record(
      {
        action: outcome.chosenAction,
        method: view.instrumentMethod,
        issuer: view.issuer,
        dayBucket: dayBucketOf(at),
        hourSlot: hourSlotOf(at),
        failureClass: view.failureClass,
        attemptBucket: attemptBucketOf(view.row.attemptCount),
      },
      view.row.id,
      at,
    )

    if (outcome.finalVerdict !== 'EXECUTE') return
    if (review?.verdict === 'BLOCK') return

    this.dispatchable.set(view.row.id, { view, outcome, decisionId })
  }

  private async dispatch(caseId: string, outcome: DecisionOutcome, at: number): Promise<void> {
    const pending = this.dispatchable.get(caseId)
    if (pending === undefined) return
    this.dispatchable.delete(caseId)

    const { view, decisionId } = pending
    const draft = this.draftFor(view, outcome.chosenAction)

    await this.options.enqueue({
      decisionId,
      caseId: view.row.id,
      type: outcome.chosenAction,
      channel: outcome.chosenChannel,
      templateId: draft === undefined ? undefined : outcome.chosenAction,
      language: draft?.language,
      amountPaise: view.outstandingPaise,
      scheduledFor: at,
      merchantId: this.options.merchantId,
      idempotencyKey: idempotencyKey(
        view.row.id,
        outcome.chosenAction,
        Math.floor(at / DECISION_WINDOW_MS),
      ),
      bestRemainingEvPaise: outcome.bestRemainingEvPaise,
      dryRun: this.options.dryRun,
    })

    for (const operational of outcome.operationalActions) {
      await this.options.enqueue({
        decisionId,
        caseId: view.row.id,
        type: operational,
        channel: undefined,
        templateId: undefined,
        language: undefined,
        amountPaise: undefined,
        scheduledFor: at,
        merchantId: this.options.merchantId,
        idempotencyKey: idempotencyKey(
          view.row.id,
          operational,
          Math.floor(at / DECISION_WINDOW_MS),
        ),
        bestRemainingEvPaise: outcome.bestRemainingEvPaise,
        dryRun: this.options.dryRun,
      })
    }
  }

  async settleFeedback(at: number, since: number): Promise<number> {
    const recovered = await this.options.db
      .select({ id: riskCases.id, resolvedAt: riskCases.resolvedAt })
      .from(riskCases)
      .where(
        and(
          eq(riskCases.merchantId, this.options.merchantId),
          eq(riskCases.state, 'RECOVERED'),
          gte(riskCases.resolvedAt, since),
        ),
      )

    let credited = 0
    for (const row of recovered) {
      credited += this.options.attribution.creditRecovery(row.id, row.resolvedAt ?? at)
    }

    this.options.attribution.expire(at)
    return credited
  }

  async runCycle(at: number, limit = 2_000): Promise<CycleStats> {
    const ids = await this.dueCases(at, limit)
    await this.options.contexts.prefetch(ids)

    let decided = 0
    let scheduled = 0
    let deferred = 0
    let suppressed = 0
    let reviewerBlocked = 0

    const pending: { caseId: string; outcome: DecisionOutcome }[] = []

    for (const caseId of ids) {
      const outcome = await this.decideCase(caseId, true)
      if (outcome === undefined) continue
      decided++

      if (outcome.finalVerdict === 'EXECUTE') {
        pending.push({ caseId, outcome })
      } else if (outcome.finalVerdict === 'DEFER') {
        deferred++
      } else {
        suppressed++
        if (outcome.suppressReason === 'REVIEWER_BLOCK') reviewerBlocked++
      }
    }

    const requests: AllocationRequest[] = pending.map(({ caseId, outcome }) => {
      const chosen = outcome.candidates.find(
        (candidate) => candidate.action === outcome.chosenAction,
      )
      return {
        caseId,
        action: outcome.chosenAction,
        channel: outcome.chosenChannel,
        evPaise: chosen?.evPaise ?? paise(0),
        costPaise: chosen?.costPaise ?? paise(0),
      }
    })

    const admitted = new Set<string>(
      this.features.allocation
        ? allocate(requests, this.options.authority)
            .decisions.filter((decision) => decision.admitted)
            .map((decision) => decision.caseId)
        : requests.map((request) => request.caseId),
    )

    let allocationDeferred = 0
    this.options.contexts.release()

    for (const { caseId, outcome } of pending) {
      if (!admitted.has(caseId)) {
        allocationDeferred++
        deferred++
        this.dispatchable.delete(caseId)
        await this.deferForBudget(caseId, at)
        continue
      }
      await this.dispatch(caseId, outcome, at)
      scheduled++
    }

    return {
      considered: ids.length,
      decided,
      scheduled,
      deferred,
      suppressed,
      reviewerBlocked,
      allocationDeferred,
    }
  }

  private async deferForBudget(caseId: string, at: number): Promise<void> {
    await this.options.db
      .update(riskCases)
      .set({ nextDecisionAt: at + 3_600_000, updatedAt: at })
      .where(eq(riskCases.id, caseId))
  }
}
