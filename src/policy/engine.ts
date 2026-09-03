import type { PolicyVerdict } from '../domain/enums'
import type { GroundingRef, PolicyEvaluation } from '../domain/records'
import type { AuthorityConfig, PolicyConfig, PolicyRuleConfig } from '../core/config-files'
import type { PolicyContext } from './context'
import { PREDICATES, type PredicateDeps, type RuleOutcome } from './predicates'

export class PolicyIntegrityError extends Error {
  override readonly name = 'PolicyIntegrityError'
}

export interface PolicyDecision {
  readonly verdict: PolicyVerdict
  readonly deferUntil: number | undefined
  readonly modifications: readonly string[]
  readonly denialReasons: readonly string[]
  readonly evaluations: readonly PolicyEvaluation[]
  readonly policyVersion: string
}

const VERDICT_RANK: Record<PolicyVerdict, number> = { ALLOW: 0, DEFER: 1, MODIFY: 2, DENY: 3 }

function applies(rule: PolicyRuleConfig, context: PolicyContext): boolean {
  if (rule.applies_to === 'ALL') return true
  if (rule.applies_to === 'ALL_CONTACT') return context.channel !== undefined
  return rule.applies_to.includes(context.action)
}

export class PolicyEngine {
  private readonly policy: PolicyConfig
  private readonly deps: PredicateDeps

  constructor(policy: PolicyConfig, authority: AuthorityConfig, bankHolidays: ReadonlySet<string>) {
    const missing = policy.rules.filter((rule) => PREDICATES[rule.id] === undefined)
    if (missing.length > 0) {
      throw new PolicyIntegrityError(
        `Policy rules declared with no predicate to enforce them: ${missing
          .map((rule) => rule.id)
          .join(', ')}. An unenforceable rule is worse than no rule.`,
      )
    }

    const declared = new Set(policy.rules.map((rule) => rule.id))
    const orphans = Object.keys(PREDICATES).filter((id) => !declared.has(id))
    if (orphans.length > 0) {
      throw new PolicyIntegrityError(
        `Predicates with no matching rule in the policy file: ${orphans.join(', ')}.`,
      )
    }

    this.policy = policy
    this.deps = { authority, bankHolidays }
  }

  get version(): string {
    return this.policy.policy_version
  }

  ruleIds(): string[] {
    return this.policy.rules.map((rule) => rule.id)
  }

  evaluate(context: PolicyContext): PolicyDecision {
    const evaluations: PolicyEvaluation[] = []
    const modifications: string[] = []
    const denialReasons: string[] = []
    let verdict: PolicyVerdict = 'ALLOW'
    let deferUntil: number | undefined

    for (const rule of this.policy.rules) {
      if (!applies(rule, context)) {
        evaluations.push({
          ruleId: rule.id,
          verdict: 'ALLOW',
          detail: `not applicable to ${context.action}`,
          ...this.groundingOf(rule),
        })
        continue
      }

      const outcome = this.run(rule, context)
      const ruleVerdict: PolicyVerdict = outcome.ok ? 'ALLOW' : (rule.on_fail as PolicyVerdict)

      if (!outcome.ok) {
        if (ruleVerdict === 'DENY') denialReasons.push(`${rule.id}: ${outcome.detail}`)
        if (outcome.modification !== undefined) modifications.push(outcome.modification)
        if (outcome.deferUntil !== undefined) {
          deferUntil =
            deferUntil === undefined ? outcome.deferUntil : Math.max(deferUntil, outcome.deferUntil)
        }
        if (VERDICT_RANK[ruleVerdict] > VERDICT_RANK[verdict]) verdict = ruleVerdict
      }

      evaluations.push({
        ruleId: rule.id,
        verdict: ruleVerdict,
        detail: outcome.detail,
        ...(outcome.deferUntil === undefined ? {} : { deferUntil: outcome.deferUntil }),
        ...this.groundingOf(rule),
      })
    }

    return {
      verdict,
      deferUntil: verdict === 'DENY' ? undefined : deferUntil,
      modifications,
      denialReasons,
      evaluations,
      policyVersion: this.policy.policy_version,
    }
  }

  private run(rule: PolicyRuleConfig, context: PolicyContext): RuleOutcome {
    const predicate = PREDICATES[rule.id]
    if (predicate === undefined) {
      return { ok: false, detail: `no predicate registered for ${rule.id}` }
    }
    try {
      return predicate(context, rule.params, this.deps)
    } catch (cause) {
      return {
        ok: false,
        detail: `rule threw and is treated as a denial: ${
          cause instanceof Error ? cause.message : 'unknown error'
        }`,
      }
    }
  }

  private groundingOf(rule: PolicyRuleConfig): { grounding?: readonly GroundingRef[] } {
    if (rule.grounding === undefined || rule.grounding.length === 0) return {}
    return {
      grounding: rule.grounding.map((entry) => ({
        source: entry.source,
        chunkId: entry.chunk_id ?? '',
        snippetHash: entry.snippet_hash ?? '',
        humanVerified: entry.human_verified,
      })),
    }
  }
}
