import type { AuthorityConfig } from '../core/config-files'
import type { Paise } from '../core/money'
import type { ActionType, Channel } from '../domain/enums'

export interface AllocationRequest {
  readonly caseId: string
  readonly action: ActionType
  readonly channel: Channel | undefined
  readonly evPaise: Paise
  readonly costPaise: Paise
}

export interface AllocationDecision {
  readonly caseId: string
  readonly admitted: boolean
  readonly reason: string | undefined
}

export interface AllocationOutcome {
  readonly decisions: readonly AllocationDecision[]
  readonly admitted: number
  readonly deferred: number
  readonly spentPaise: number
  readonly contacts: number
}

const DEFER_ACTIONS = 'cycle action budget exhausted'
const DEFER_CONTACTS = 'cycle contact budget exhausted'
const DEFER_SPEND = 'cycle spend budget exhausted'

function density(request: AllocationRequest): number {
  return request.evPaise / Math.max(1, request.costPaise)
}

export function allocate(
  requests: readonly AllocationRequest[],
  authority: AuthorityConfig,
): AllocationOutcome {
  const limits = authority.allocation

  const ranked = [...requests].sort((a, b) => {
    const byDensity = density(b) - density(a)
    if (byDensity !== 0) return byDensity
    const byValue = b.evPaise - a.evPaise
    if (byValue !== 0) return byValue
    return a.caseId < b.caseId ? -1 : 1
  })

  const decisions: AllocationDecision[] = []
  let actions = 0
  let contacts = 0
  let spent = 0

  for (const request of ranked) {
    const isContact = request.channel !== undefined
    let reason: string | undefined

    if (actions >= limits.max_actions_per_cycle) reason = DEFER_ACTIONS
    else if (isContact && contacts >= limits.max_contacts_per_cycle) reason = DEFER_CONTACTS
    else if (spent + request.costPaise > limits.max_spend_per_cycle_paise) reason = DEFER_SPEND

    if (reason === undefined) {
      actions++
      if (isContact) contacts++
      spent += request.costPaise
      decisions.push({ caseId: request.caseId, admitted: true, reason: undefined })
    } else {
      decisions.push({ caseId: request.caseId, admitted: false, reason })
    }
  }

  return {
    decisions,
    admitted: decisions.filter((decision) => decision.admitted).length,
    deferred: decisions.filter((decision) => !decision.admitted).length,
    spentPaise: spent,
    contacts,
  }
}
