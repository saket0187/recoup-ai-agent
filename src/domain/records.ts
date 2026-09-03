import type { Paise } from '../core/money'
import type {
  ActionType,
  Channel,
  PolicyVerdict,
  StopReason,
  StopVerdict,
  PaymentMethod,
} from './enums'

export type FeatureValue = string | number | boolean | null

export type FeatureSnapshot = Readonly<Record<string, FeatureValue>>

export interface ActionCandidate {
  readonly action: ActionType
  readonly channel?: Channel
  readonly pSuccess: number
  readonly uplift: number
  readonly evPaise: Paise
  readonly costPaise: Paise
  readonly rationale: string
}

export interface GroundingRef {
  readonly source: string
  readonly chunkId: string
  readonly snippetHash: string
  readonly humanVerified: boolean
}

export interface PolicyEvaluation {
  readonly ruleId: string
  readonly action?: ActionType
  readonly channel?: Channel
  readonly verdict: PolicyVerdict
  readonly detail: string
  readonly deferUntil?: number
  readonly grounding?: readonly GroundingRef[]
}

export interface StopEvaluation {
  readonly ruleId: StopReason
  readonly verdict: StopVerdict
  readonly detail: string
}

export interface DiagnosisEvidence {
  readonly field: string
  readonly value: string
}

export interface SourceEntity {
  readonly orderId?: string
  readonly paymentId?: string
  readonly subscriptionId?: string
  readonly invoiceId?: string
}

export interface ProviderErrorSignature {
  readonly source: string
  readonly step: string
  readonly reason: string
  readonly method?: PaymentMethod
  readonly issuer?: string
}
