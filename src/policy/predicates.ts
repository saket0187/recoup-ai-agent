import {
  addIstDays,
  atIst,
  isBankingDay,
  isWithinIstWindow,
  nextBankingDay,
  nextIstWindowStart,
} from '../core/calendar'
import { findPii } from '../core/personal-data'
import type { AuthorityConfig } from '../core/config-files'
import type { PolicyContext } from './context'
import { RUNGS, rungIndexOf } from './escalation'
import { findDarkPattern, findLegalAuthorityClaim, findShaming, findThreat } from './lexicon'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface RuleOutcome {
  readonly ok: boolean
  readonly detail: string
  readonly deferUntil?: number
  readonly modification?: string
}

export interface PredicateDeps {
  readonly authority: AuthorityConfig
  readonly bankHolidays: ReadonlySet<string>
}

export type RuleParams = Readonly<Record<string, unknown>>

export type RulePredicate = (
  context: PolicyContext,
  params: RuleParams,
  deps: PredicateDeps,
) => RuleOutcome

const pass = (detail: string): RuleOutcome => ({ ok: true, detail })
const fail = (detail: string, deferUntil?: number, modification?: string): RuleOutcome => ({
  ok: false,
  detail,
  ...(deferUntil === undefined ? {} : { deferUntil }),
  ...(modification === undefined ? {} : { modification }),
})

function requireNumber(params: RuleParams, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`policy parameter "${key}" must be a number, got ${typeof value}`)
  }
  return value
}

function requireStrings(params: RuleParams, key: string): readonly string[] {
  const value = params[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`policy parameter "${key}" must be an array of strings`)
  }
  return value as readonly string[]
}

function nextMorning(at: number): number {
  return atIst(addIstDays(at, 1), 10)
}

export const PREDICATES: Readonly<Record<string, RulePredicate>> = {
  QUIET_HOURS: (context, params) => {
    const start = requireNumber(params, 'start_hour')
    const end = requireNumber(params, 'end_hour')
    if (isWithinIstWindow(context.at, start, end)) {
      return pass(`local time is inside ${start}:00–${end}:00`)
    }
    return fail(
      `local time is outside ${start}:00–${end}:00`,
      nextIstWindowStart(context.at, start, end),
    )
  },

  GOOD_PAYER_GRACE: (context, params) => {
    const minimumHistory = requireNumber(params, 'min_prior_cases')
    const requiredRate = requireNumber(params, 'min_recovery_rate')
    const graceDays = requireNumber(params, 'grace_days')

    if (context.priorCasesResolved < minimumHistory) {
      return pass(
        `only ${context.priorCasesResolved} settled cases on record, too few to earn grace`,
      )
    }

    const rate = context.priorCasesRecovered / context.priorCasesResolved
    if (rate < requiredRate) {
      return pass(`prior recovery rate ${(rate * 100).toFixed(0)}% is below the grace threshold`)
    }

    if (context.caseAgeDays >= graceDays) {
      return pass(`grace of ${graceDays} days has passed on a reliable payer`)
    }

    return fail(
      `${context.priorCasesRecovered} of ${context.priorCasesResolved} previous bills settled; ` +
        `holding contact for ${graceDays} days before chasing`,
      context.at + (graceDays - context.caseAgeDays) * DAY_MS,
    )
  },

  RECOVERY_CALL_HOURS: (context, params) => {
    const start = requireNumber(params, 'start_hour')
    const end = requireNumber(params, 'end_hour')
    if (isWithinIstWindow(context.at, start, end)) {
      return pass(`call time is inside ${start}:00–${end}:00`)
    }
    return fail(
      `call time is outside ${start}:00–${end}:00`,
      nextIstWindowStart(context.at, start, end),
    )
  },

  NO_HOLIDAY_DUNNING: (context) =>
    context.isFestival
      ? fail('a major festival is in progress', nextMorning(context.at))
      : pass('not a festival period'),

  BANK_HOLIDAY_MANDATE: (context, _params, deps) =>
    isBankingDay(context.at, deps.bankHolidays)
      ? pass('is a banking day')
      : fail('not a banking day', nextBankingDay(context.at, deps.bankHolidays)),

  CONSENT_REQUIRED: (context) => {
    const channel = context.channel
    if (channel === undefined) return pass('no channel, consent not applicable')
    const consent = context.consentByChannel[channel]
    if (consent === undefined) return fail(`no consent record for ${channel}`)
    if (!consent.granted) return fail(`consent for ${channel} was never granted`)
    if (consent.revokedAt !== undefined && consent.revokedAt <= context.at) {
      return fail(`consent for ${channel} was revoked`)
    }
    return pass(`consent for ${channel} is granted`)
  },

  OPT_OUT_ABSOLUTE: (context) =>
    context.optedOutGlobal
      ? fail('the customer has opted out of all contact')
      : pass('no global opt-out'),

  DND_SCRUB: (context, params) => {
    const channel = context.channel
    if (channel === undefined) return pass('no channel, DND not applicable')
    const restricted = requireStrings(params, 'restricted_channels')
    if (!restricted.includes(channel)) return pass(`${channel} is not DND-restricted`)
    return context.dnd
      ? fail(`${channel} is DND-registered and this is not a transactional send`)
      : pass('not DND-registered')
  },

  PROMO_RECLASSIFY: (context, params) => {
    if (context.content?.includesOffer !== true) return pass('no offer, stays transactional')
    const start = requireNumber(params, 'promo_start_hour')
    const end = requireNumber(params, 'promo_end_hour')
    if (isWithinIstWindow(context.at, start, end)) {
      return pass(`offer sent inside promotional hours ${start}:00–${end}:00`)
    }
    return fail(
      `an offer is promotional and falls outside ${start}:00–${end}:00`,
      nextIstWindowStart(context.at, start, end),
    )
  },

  WA_SESSION_WINDOW: (context, params) => {
    if (context.channel !== 'WHATSAPP') return pass('not a WhatsApp send')
    const windowHours = requireNumber(params, 'session_hours')
    const lastInbound = context.lastInboundAt
    if (lastInbound !== undefined && context.at - lastInbound < windowHours * HOUR_MS) {
      return pass('inside the customer-initiated session window')
    }
    return fail(
      'outside the session window, free-form is not permitted',
      undefined,
      'use an approved template',
    )
  },

  FREQ_PER_CHANNEL_DAY: (context, params) => {
    const channel = context.channel
    if (channel === undefined) return pass('no channel')
    const cap = requireNumber(params, 'max_per_channel_24h')
    const sent = context.touchesByChannel24h[channel] ?? 0
    return sent < cap
      ? pass(`${sent} of ${cap} ${channel} sends used in 24h`)
      : fail(`${sent} ${channel} sends already in 24h`, context.at + DAY_MS)
  },

  FREQ_PER_CASE_WEEK: (context, params) => {
    const cap = requireNumber(params, 'max_per_case_7d')
    return context.touchesCase7d < cap
      ? pass(`${context.touchesCase7d} of ${cap} case touches used in 7d`)
      : fail(`${context.touchesCase7d} case touches already in 7d`, context.at + DAY_MS)
  },

  FREQ_GLOBAL_CUSTOMER_WEEK: (context, params) => {
    const cap = requireNumber(params, 'max_per_customer_7d')
    return context.touchesCustomer7d < cap
      ? pass(`${context.touchesCustomer7d} of ${cap} customer touches used in 7d`)
      : fail(
          `${context.touchesCustomer7d} touches across all cases for this customer in 7d`,
          context.at + DAY_MS,
        )
  },

  MIN_GAP_BETWEEN_TOUCHES: (context, params) => {
    const gapHours = requireNumber(params, 'min_gap_hours')
    const last = context.lastTouchAt
    if (last === undefined) return pass('no previous touch')
    const elapsed = context.at - last
    return elapsed >= gapHours * HOUR_MS
      ? pass(`${Math.floor(elapsed / HOUR_MS)}h since the last touch`)
      : fail(
          `only ${Math.floor(elapsed / HOUR_MS)}h since the last touch`,
          last + gapHours * HOUR_MS,
        )
  },

  ESCALATION_ORDER: (context) => {
    const requested = rungIndexOf(context.action)
    return requested <= context.rungReached + 1
      ? pass(`rung ${requested} is at most one above ${context.rungReached}`)
      : fail(`rung ${requested} skips past ${context.rungReached}`)
  },

  ESCALATION_COOLDOWN: (context, _params, deps) => {
    const requested = rungIndexOf(context.action)
    if (requested <= context.rungReached) return pass('not an escalation')

    const changedAt = context.lastRungChangeAt
    if (changedAt === undefined) return pass('no prior rung change')

    const rungName = RUNGS[context.rungReached]
    const dwell =
      deps.authority.escalation.rungs.find((rung) => rung.name === rungName)?.min_dwell_days ?? 0
    const elapsedDays = (context.at - changedAt) / DAY_MS

    return elapsedDays >= dwell
      ? pass(`${elapsedDays.toFixed(1)}d at rung ${rungName}, dwell ${dwell}d satisfied`)
      : fail(
          `only ${elapsedDays.toFixed(1)}d at rung ${rungName}, needs ${dwell}d`,
          changedAt + dwell * DAY_MS,
        )
  },

  NO_ESCALATION_DURING_PTP: (context) =>
    context.hasActivePromise
      ? fail('an unbroken promise to pay is active', context.at + DAY_MS)
      : pass('no active promise'),

  NO_ESCALATION_DURING_DISPUTE: (context) =>
    context.disputeOpen ? fail('a dispute is open on this case') : pass('no open dispute'),

  THIRD_PARTY_DISCLOSURE: (context) =>
    context.contactRoleAuthorised
      ? pass('recipient is the obligor or an authorised contact')
      : fail('recipient is not an authorised party for this obligation'),

  NO_THREATS: (context) => {
    const body = context.content?.body
    if (body === undefined) return pass('no drafted content')
    const hit = findThreat(body)
    return hit === undefined
      ? pass('no threatening language')
      : fail(`threatening phrase "${hit.term}"`)
  },

  NO_LEGAL_IMPERSONATION: (context, params) => {
    const body = context.content?.body
    if (body === undefined) return pass('no drafted content')
    const hit = findLegalAuthorityClaim(body)
    if (hit === undefined) return pass('no claim of legal authority')

    const allowedFrom = params['allowed_from_rung']
    const allowedIndex =
      typeof allowedFrom === 'string' ? RUNGS.indexOf(allowedFrom as (typeof RUNGS)[number]) : -1
    const permitted =
      allowedIndex >= 0 && rungIndexOf(context.action) >= allowedIndex && context.humanApproved

    return permitted
      ? pass(`legal language permitted at this rung with human approval`)
      : fail(`claims legal authority ("${hit.term}") without an approved formal notice`)
  },

  NO_DARK_PATTERNS: (context) => {
    const body = context.content?.body
    if (body === undefined) return pass('no drafted content')
    const hit = findDarkPattern(body)
    return hit === undefined
      ? pass('no manufactured urgency or scarcity')
      : fail(`dark pattern "${hit.term}": urgency we cannot actually justify`)
  },

  NO_SHAMING: (context) => {
    const body = context.content?.body
    if (body === undefined) return pass('no drafted content')
    const hit = findShaming(body)
    return hit === undefined ? pass('no shaming language') : fail(`shaming phrase "${hit.term}"`)
  },

  LANGUAGE_MATCH: (context) => {
    const content = context.content
    if (content === undefined) return pass('no drafted content')
    return content.language === context.preferredLanguage
      ? pass(`content is in ${content.language}`)
      : fail(`content is ${content.language} but the customer prefers ${context.preferredLanguage}`)
  },

  AMOUNT_ACCURACY: (context) => {
    const content = context.content
    if (content === undefined) return pass('no drafted content')
    return content.amountPaise === context.outstandingPaise
      ? pass('quoted amount matches the ledger')
      : fail(
          `quoted ${content.amountPaise} but the ledger says ${context.outstandingPaise} right now`,
        )
  },

  PII_MINIMISATION: (context) => {
    const payload = context.modelPayload
    if (payload === undefined) return pass('no model payload')
    const findings = findPii(payload)
    return findings.length === 0
      ? pass('model payload carries no personal data')
      : fail(`model payload carries ${findings.map((f) => f.kind).join(', ')}`)
  },

  PURPOSE_LIMITATION: (context, params) => {
    const channel = context.channel
    if (channel === undefined) return pass('no channel')
    const required = params['required_purpose']
    if (typeof required !== 'string') throw new TypeError('required_purpose must be a string')
    const consent = context.consentByChannel[channel]
    if (consent === undefined) return fail(`no consent record to check purpose against`)
    return consent.purpose.includes(required)
      ? pass(`consent purpose covers ${required}`)
      : fail(`consent purpose "${consent.purpose}" does not cover ${required}`)
  },

  ERASURE_HONOURED: (context) =>
    context.erasureRequestedAt !== undefined && context.erasureRequestedAt <= context.at
      ? fail('the customer has requested erasure of their data')
      : pass('no erasure request on file'),

  PRE_DEBIT_NOTICE: (context, params) => {
    const method = context.instrumentMethod
    const mandateMethods = requireStrings(params, 'mandate_methods')
    if (method === undefined || !mandateMethods.includes(method)) {
      return pass('not a mandate-backed debit')
    }
    const noticeHours = requireNumber(params, 'notice_hours')
    const sentAt = context.preDebitNoticeSentAt
    if (sentAt === undefined) {
      return fail('no pre-debit notice has been sent', context.at + noticeHours * HOUR_MS)
    }
    const elapsed = context.at - sentAt
    return elapsed >= noticeHours * HOUR_MS
      ? pass(`pre-debit notice sent ${Math.floor(elapsed / HOUR_MS)}h ago`)
      : fail(
          `pre-debit notice sent only ${Math.floor(elapsed / HOUR_MS)}h ago`,
          sentAt + noticeHours * HOUR_MS,
        )
  },

  MANDATE_CAP: (context) => {
    const cap = context.mandateCapPaise
    if (cap === undefined) return pass('no mandate cap applies')
    return context.outstandingPaise <= cap
      ? pass(`amount is within the mandate cap of ${cap}`)
      : fail(
          `amount ${context.outstandingPaise} exceeds the mandate cap ${cap}`,
          undefined,
          'split the retry or re-authorise the mandate',
        )
  },

  NETWORK_ATTEMPT_CAP: (context, params) => {
    const cap = requireNumber(params, 'max_attempts_30d')
    return context.cardAttempts30d < cap
      ? pass(`${context.cardAttempts30d} of ${cap} network attempts used in 30d`)
      : fail(`${context.cardAttempts30d} attempts in 30d would look like card testing`)
  },

  NO_RETRY_INTO_DOWNTIME: (context) =>
    context.cohortPaused
      ? fail('the route for this instrument is paused', context.at + HOUR_MS)
      : pass('route is healthy'),

  DISCOUNT_WITHIN_AUTHORITY: (context, _params, deps) => {
    const pct = context.discountPct
    const amount = context.discountPaise
    if (pct === undefined && amount === undefined) return pass('no discount requested')

    const { max_pct: maxPct, max_paise: maxPaise } = deps.authority.discount
    if (pct !== undefined && pct > maxPct) {
      return fail(`discount of ${pct}% exceeds the ${maxPct}% cap`)
    }
    if (amount !== undefined && amount > maxPaise) {
      return fail(`discount of ${amount} paise exceeds the ${maxPaise} cap`)
    }
    return pass('discount is within delegated authority')
  },

  EXTENSION_WITHIN_AUTHORITY: (context, _params, deps) => {
    const days = context.extensionDays
    if (days === undefined) return pass('no extension requested')
    const max = deps.authority.extension.max_days
    return days <= max
      ? pass(`extension of ${days}d is within the ${max}d cap`)
      : fail(`extension of ${days}d exceeds the ${max}d cap`)
  },

  HUMAN_APPROVAL_ABOVE_CEILING: (context, _params, deps) => {
    const ceiling = deps.authority.thresholds.human_approval_required_above_paise
    if (context.outstandingPaise <= ceiling) return pass(`below the ${ceiling} approval ceiling`)
    return context.humanApproved
      ? pass('above the ceiling but human-approved')
      : fail(`amount ${context.outstandingPaise} is above ${ceiling} and needs human approval`)
  },
}
