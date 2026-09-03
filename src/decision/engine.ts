import type { AuthorityConfig, CostsConfig } from '../core/config-files'
import { paise, type Paise } from '../core/money'
import type { Rng } from '../core/seeded-random'
import type {
  ActionType,
  Arm,
  Channel,
  ChosenBy,
  FailureClass,
  FinalVerdict,
  PaymentMethod,
} from '../domain/enums'
import type {
  ActionCandidate,
  FeatureSnapshot,
  PolicyEvaluation,
  StopEvaluation,
} from '../domain/records'
import type { PolicyContext } from '../policy/context'
import type { PolicyEngine } from '../policy/engine'
import { evaluateStopGate, type StopContext } from '../policy/stop-gate'
import {
  attemptBucketOf,
  dayBucketOf,
  hourSlotOf,
  type ArmKey,
  type ThompsonBandit,
} from './bandit'
import { controlAction } from './control-arm'
import { valueOf } from './economics'
import { candidatesFor, PLAYBOOK_VERSION, type CandidateSpec } from './playbook'
import type { CaseFeatures } from '../uplift/features'
import { modelCanRank, predictUplift, type UpliftModel } from '../uplift/model'

const PROPENSITY_SAMPLES = 200

export interface EngineFeatures {
  readonly timeBucketedArms: boolean
  readonly diagnosis: boolean
  readonly uplift: boolean
  readonly policyGate: boolean
  readonly incumbentFloor: boolean
  readonly reviewer: boolean
  readonly allocation: boolean
  readonly actionSkillGate: boolean
}

export const ALL_FEATURES: EngineFeatures = {
  timeBucketedArms: true,
  diagnosis: true,
  uplift: true,
  policyGate: true,
  incumbentFloor: true,
  reviewer: true,
  allocation: true,
  actionSkillGate: true,
}

function sameAction(a: { action: ActionType; channel?: Channel }, b: CandidateSpec): boolean {
  return a.action === b.action && a.channel === b.channel
}

export interface DecisionRequest {
  readonly at: number
  readonly caseId: string
  readonly arm: Arm
  readonly failureClass: FailureClass
  readonly outstandingPaise: Paise
  readonly originalAmountPaise: Paise
  readonly method: PaymentMethod | undefined
  readonly issuer: string | undefined
  readonly attemptCount: number
  readonly touchCount: number
  readonly cohortPaused: boolean
  readonly mandateCapExceeded: boolean
  readonly preferredChannel: Channel
  readonly firstSeenAt: number
  readonly features: FeatureSnapshot
  readonly upliftFeatures: CaseFeatures
  policyContextFor(action: ActionType, channel: Channel | undefined): PolicyContext
  stopContextFor(action: ActionType, bestRemainingEvPaise: Paise): StopContext
}

export interface ScoredCandidate extends ActionCandidate {
  readonly admissible: boolean
  readonly denialReasons: readonly string[]
  readonly modifications: readonly string[]
  readonly deferUntil: number | undefined
}

export interface DecisionOutcome {
  readonly chosenAction: ActionType
  readonly chosenChannel: Channel | undefined
  readonly chosenBy: ChosenBy
  readonly propensity: number
  readonly candidates: readonly ScoredCandidate[]
  readonly policyEvaluations: readonly PolicyEvaluation[]
  readonly stopEvaluations: readonly StopEvaluation[]
  readonly finalVerdict: FinalVerdict
  readonly deferUntil: number | undefined
  readonly suppressReason: string | undefined
  readonly policyVersion: string
  readonly playbookVersion: string
  readonly operationalActions: readonly ActionType[]
  readonly bestRemainingEvPaise: Paise
}

export interface EngineOptions {
  readonly policy: PolicyEngine
  readonly authority: AuthorityConfig
  readonly costs: CostsConfig
  readonly bandit: ThompsonBandit
  readonly rng: Rng
  readonly features?: EngineFeatures
  readonly upliftModel?: UpliftModel
}

export class DecisionEngine {
  private readonly policy: PolicyEngine
  private readonly authority: AuthorityConfig
  private readonly costs: CostsConfig
  private readonly bandit: ThompsonBandit
  private readonly propensityRng: Rng
  private readonly features: EngineFeatures
  private readonly modelRanked = new Set<string>()
  private readonly upliftModel: UpliftModel | undefined

  constructor(options: EngineOptions) {
    this.policy = options.policy
    this.authority = options.authority
    this.costs = options.costs
    this.bandit = options.bandit
    this.propensityRng = options.rng.derive('propensity')
    this.features = options.features ?? ALL_FEATURES
    this.upliftModel = options.upliftModel
  }

  private modelledUplift(request: DecisionRequest, spec: CandidateSpec): number | undefined {
    if (this.upliftModel === undefined || !this.features.uplift) return undefined

    const action = { action: spec.action, channel: spec.channel }
    if (this.features.actionSkillGate && !modelCanRank(this.upliftModel, action)) return undefined

    return predictUplift(this.upliftModel, request.upliftFeatures, action)
  }

  private armKey(request: DecisionRequest, action: ActionType): ArmKey {
    return {
      action,
      method: request.method,
      issuer: request.issuer,
      dayBucket: this.features.timeBucketedArms ? dayBucketOf(request.at) : 'any',
      hourSlot: this.features.timeBucketedArms ? hourSlotOf(request.at) : 0,
      failureClass: this.features.diagnosis ? request.failureClass : 'AMBIGUOUS',
      attemptBucket: attemptBucketOf(request.attemptCount),
    }
  }

  private incumbentChoice(request: DecisionRequest): CandidateSpec {
    return controlAction({
      at: request.at,
      firstSeenAt: request.firstSeenAt,
      attemptCount: request.attemptCount,
      touchCount: request.touchCount,
    })
  }

  private specsFor(request: DecisionRequest): CandidateSpec[] {
    const incumbent = this.incumbentChoice(request)
    if (request.arm === 'CONTROL') return [incumbent]

    const playbook = candidatesFor({
      failureClass: this.features.diagnosis ? request.failureClass : 'AMBIGUOUS',
      attemptCount: request.attemptCount,
      touchCount: request.touchCount,
      cohortPaused: request.cohortPaused,
      mandateCapExceeded: request.mandateCapExceeded,
      preferredChannel: request.preferredChannel,
    })

    if (!this.features.incumbentFloor) return playbook
    if (incumbent.action === 'WAIT') return playbook
    if (playbook.some((spec) => sameAction(spec, incumbent))) return playbook

    return [...playbook, incumbent]
  }

  private score(
    request: DecisionRequest,
    spec: CandidateSpec,
    pSuccess: number,
    baseline: number,
  ): { uplift: number; evPaise: Paise; costPaise: Paise } {
    const recovers = spec.action !== 'WAIT' && spec.operational !== true
    const modelled = recovers ? this.modelledUplift(request, spec) : undefined
    if (modelled !== undefined) this.modelRanked.add(`${spec.action}|${spec.channel ?? ''}`)

    let uplift: number
    if (!recovers) {
      uplift = 0
    } else if (modelled !== undefined) {
      uplift = modelled + (pSuccess - this.bandit.mean(this.armKey(request, spec.action)))
    } else if (!this.features.uplift) {
      uplift = pSuccess
    } else {
      uplift = Math.max(0, pSuccess - baseline)
    }
    const valued = valueOf(
      {
        action: spec.action,
        channel: spec.channel,
        uplift,
        outstandingPaise: request.outstandingPaise,
        touchCount: request.touchCount,
      },
      this.costs,
    )
    return { uplift, evPaise: valued.evPaise, costPaise: valued.cost.totalPaise }
  }

  decide(request: DecisionRequest): DecisionOutcome {
    this.modelRanked.clear()
    const specs = this.specsFor(request)
    const useSampling = request.arm === 'TREATMENT'

    const draw = (action: ActionType): number =>
      useSampling
        ? this.bandit.sample(this.armKey(request, action))
        : this.bandit.mean(this.armKey(request, action))

    const baseline = this.bandit.mean(this.armKey(request, 'WAIT'))

    const policyEvaluations: PolicyEvaluation[] = []
    const seenRules = new Set<string>()
    const scored: ScoredCandidate[] = []

    for (const spec of specs) {
      const decision = this.policy.evaluate(request.policyContextFor(spec.action, spec.channel))
      const gated = this.features.policyGate

      for (const evaluation of decision.evaluations) {
        const key = `${spec.action}:${spec.channel ?? ''}:${evaluation.ruleId}`
        if (seenRules.has(key)) continue
        seenRules.add(key)
        if (evaluation.verdict !== 'ALLOW') {
          policyEvaluations.push({
            ...evaluation,
            action: spec.action,
            ...(spec.channel === undefined ? {} : { channel: spec.channel }),
          })
        }
      }

      const pSuccess = draw(spec.action)
      const { uplift, evPaise, costPaise } = this.score(request, spec, pSuccess, baseline)

      scored.push({
        action: spec.action,
        ...(spec.channel === undefined ? {} : { channel: spec.channel }),
        pSuccess,
        uplift,
        evPaise,
        costPaise,
        rationale: spec.rationale,
        admissible: !gated || decision.verdict === 'ALLOW' || decision.verdict === 'MODIFY',
        modifications: decision.modifications,
        denialReasons: decision.denialReasons,
        deferUntil: decision.deferUntil,
      })
    }

    if (policyEvaluations.length === 0) {
      const allowed = this.policy.evaluate(
        request.policyContextFor(specs[0]?.action ?? 'WAIT', specs[0]?.channel),
      )
      policyEvaluations.push(...allowed.evaluations.filter((e) => e.ruleId === 'OPT_OUT_ABSOLUTE'))
    }

    const operationalActions = specs
      .filter((spec) => spec.operational === true)
      .map((spec) => spec.action)

    const operationalSet = new Set<ActionType>(operationalActions)
    const admissible = scored.filter(
      (candidate) => candidate.admissible && !operationalSet.has(candidate.action),
    )
    const best = admissible.reduce<ScoredCandidate | undefined>(
      (leader, candidate) =>
        leader === undefined || candidate.evPaise > leader.evPaise ? candidate : leader,
      undefined,
    )

    const fallback = scored.find((candidate) => candidate.action === 'WAIT')

    const scheduled = request.arm === 'CONTROL' ? scored.find((c) => c.admissible) : undefined

    const incumbent = this.incumbentChoice(request)
    const floor =
      request.arm === 'TREATMENT' && this.features.incumbentFloor && incumbent.action !== 'WAIT'
        ? scored.find((candidate) => candidate.admissible && sameAction(candidate, incumbent))
        : undefined

    const chosen =
      scheduled ??
      (best !== undefined && best.evPaise > 0
        ? best
        : (floor ??
          fallback ?? {
            action: 'WAIT' as ActionType,
            pSuccess: 0,
            uplift: 0,
            evPaise: paise(0),
            costPaise: paise(0),
            rationale: 'no admissible action has positive expected value',
            admissible: true,
            denialReasons: [],
            modifications: [],
            deferUntil: undefined,
          }))

    const fallbackAction: ActionType = (floor ?? fallback)?.action ?? 'WAIT'
    const bestRemainingEv = best?.evPaise ?? paise(0)
    const stop = evaluateStopGate(
      request.stopContextFor(chosen.action, bestRemainingEv),
      this.authority,
    )

    const earliestDefer = scored
      .map((candidate) => candidate.deferUntil)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b)[0]

    const deferUntil =
      stop.verdict === 'DEFER'
        ? Math.max(stop.deferUntil ?? request.at, earliestDefer ?? request.at)
        : chosen.admissible
          ? undefined
          : earliestDefer

    let finalVerdict: FinalVerdict = 'EXECUTE'
    let suppressReason: string | undefined

    if (stop.verdict === 'STOP') {
      finalVerdict = 'SUPPRESS'
      suppressReason = stop.reason
    } else if (stop.verdict === 'DEFER' || deferUntil !== undefined) {
      finalVerdict = 'DEFER'
    } else if (chosen.action === 'WAIT') {
      finalVerdict = 'SUPPRESS'
      suppressReason = 'NO_POSITIVE_EV'
    }

    return {
      chosenAction: chosen.action,
      chosenChannel: chosen.channel,
      chosenBy: this.modelRanked.has(`${chosen.action}|${chosen.channel ?? ''}`)
        ? 'MODEL'
        : 'PLAYBOOK',
      propensity: this.propensityOf(request, scored, chosen.action, fallbackAction),
      candidates: scored,
      policyEvaluations,
      stopEvaluations: stop.evaluations,
      finalVerdict,
      deferUntil,
      suppressReason,
      policyVersion: this.policy.version,
      playbookVersion: PLAYBOOK_VERSION,
      operationalActions,
      bestRemainingEvPaise: bestRemainingEv,
    }
  }

  private propensityOf(
    request: DecisionRequest,
    scored: readonly ScoredCandidate[],
    chosen: ActionType,
    deterministicFallback: ActionType,
  ): number {
    const admissible = scored.filter((candidate) => candidate.admissible)
    if (admissible.length <= 1) return 1

    if (request.arm === 'CONTROL') return 1

    const baseline = this.bandit.mean(this.armKey(request, 'WAIT'))
    let wins = 0

    for (let trial = 0; trial < PROPENSITY_SAMPLES; trial++) {
      let bestAction: ActionType | undefined
      let bestEv = paise(Number.MIN_SAFE_INTEGER)

      for (const candidate of admissible) {
        const key = this.armKey(request, candidate.action)
        const { alpha, beta } = this.bandit.posterior(key)
        const pSuccess = this.propensityRng.beta(alpha, beta)
        const { evPaise } = this.score(
          request,
          { action: candidate.action, channel: candidate.channel, rationale: '' },
          pSuccess,
          baseline,
        )
        if (evPaise > bestEv) {
          bestEv = evPaise
          bestAction = candidate.action
        }
      }

      const drawn = bestEv > 0 ? bestAction : deterministicFallback
      if (drawn === chosen) wins++
    }

    return (wins + 1) / (PROPENSITY_SAMPLES + admissible.length)
  }
}
