import type { Paise } from '../core/money'
import type { ActionType, Channel, Language, PaymentMethod } from '../domain/enums'

export interface ConsentView {
  readonly granted: boolean
  readonly purpose: string
  readonly revokedAt: number | undefined
}

export interface DraftContent {
  readonly body: string
  readonly language: Language
  readonly amountPaise: Paise
  readonly includesOffer: boolean
}

export interface PolicyContext {
  readonly at: number
  readonly action: ActionType
  readonly channel: Channel | undefined

  readonly caseId: string
  readonly customerId: string
  readonly outstandingPaise: Paise
  readonly caseAgeDays: number
  readonly disputeOpen: boolean
  readonly hasActivePromise: boolean

  readonly optedOutGlobal: boolean
  readonly dnd: boolean
  readonly erasureRequestedAt: number | undefined
  readonly preferredLanguage: Language
  readonly consentByChannel: Readonly<Partial<Record<Channel, ConsentView>>>
  readonly contactRoleAuthorised: boolean

  readonly touchesByChannel24h: Readonly<Partial<Record<Channel, number>>>
  readonly touchesCase7d: number
  readonly touchesCustomer7d: number
  readonly lastTouchAt: number | undefined
  readonly lastInboundAt: number | undefined

  readonly priorCasesResolved: number
  readonly priorCasesRecovered: number

  readonly rungReached: number
  readonly lastRungChangeAt: number | undefined

  readonly isFestival: boolean
  readonly cohortPaused: boolean

  readonly instrumentMethod: PaymentMethod | undefined
  readonly mandateCapPaise: Paise | undefined
  readonly preDebitNoticeSentAt: number | undefined
  readonly cardAttempts30d: number

  readonly discountPct: number | undefined
  readonly discountPaise: Paise | undefined
  readonly extensionDays: number | undefined
  readonly humanApproved: boolean

  readonly content: DraftContent | undefined
  readonly modelPayload: string | undefined
}
