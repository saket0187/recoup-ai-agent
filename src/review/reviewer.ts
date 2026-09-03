import type { Paise } from '../core/money'
import { formatINR } from '../core/money'
import type { Language } from '../domain/enums'

export interface ReviewSubject {
  readonly body: string
  readonly language: Language
  readonly preferredLanguage: Language
  readonly amountPaise: Paise
  readonly includesOffer: boolean
  readonly offerCapPaise: Paise
}

export type ReviewSeverity = 'BLOCK' | 'REVISE'

export interface ReviewFinding {
  readonly ruleId: string
  readonly severity: ReviewSeverity
  readonly detail: string
}

export interface ReviewOutcome {
  readonly verdict: 'PASS' | 'BLOCK'
  readonly reason: string | undefined
  readonly findings: readonly ReviewFinding[]
}

const THREAT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['REVIEW_LEGAL_THREAT', /\b(legal action|lawsuit|sue you|court|summons|prosecut\w*)\b/i],
  ['REVIEW_POLICE_THREAT', /\b(police|arrest|fir\b|criminal|jail)\b/i],
  ['REVIEW_DEFAMATION', /\b(defaulter list|blacklist|inform your employer|tell your family)\b/i],
  ['REVIEW_COERCION', /\b(seize|repossess|recovery agent|visit your (home|address))\b/i],
  ['REVIEW_ABUSE', /\b(shameless|fraud|cheat|thief|liar)\b/i],
]

const MAX_BODY_LENGTH = 700

function scannableText(body: string): string {
  return body
    .replaceAll(/https?:\/\/\S+/g, ' ')
    .replaceAll(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replaceAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replaceAll(/\b[A-Za-z]+_[A-Za-z0-9_]+\b/g, ' ')
}

function numbersIn(body: string): number[] {
  const matches = scannableText(body).matchAll(/(?:₹\s?)?(\d[\d,]*(?:\.\d{1,2})?)/g)
  const values: number[] = []

  for (const match of matches) {
    const raw = match[1]
    if (raw === undefined) continue
    const parsed = Number.parseFloat(raw.replaceAll(',', ''))
    if (Number.isFinite(parsed)) values.push(parsed)
  }

  return values
}

export function review(subject: ReviewSubject): ReviewOutcome {
  const findings: ReviewFinding[] = []

  for (const [ruleId, pattern] of THREAT_PATTERNS) {
    if (pattern.test(subject.body)) {
      findings.push({
        ruleId,
        severity: 'BLOCK',
        detail: `copy matches a prohibited collections pattern (${ruleId})`,
      })
    }
  }

  const rupees = subject.amountPaise / 100
  const allowed = new Set([rupees, Math.round(rupees), subject.amountPaise])
  const stray = numbersIn(subject.body).filter(
    (value) => value > 99 && !allowed.has(value) && !allowed.has(Math.round(value)),
  )

  if (stray.length > 0) {
    findings.push({
      ruleId: 'REVIEW_UNGROUNDED_FIGURE',
      severity: 'BLOCK',
      detail:
        `copy contains ${stray[0]} which is not the ledger amount ` +
        `${formatINR(subject.amountPaise)}; figures come from the ledger at send time`,
    })
  }

  if (subject.includesOffer && subject.amountPaise > subject.offerCapPaise) {
    findings.push({
      ruleId: 'REVIEW_OFFER_BEYOND_CAP',
      severity: 'BLOCK',
      detail: 'the drafted offer exceeds the bounded authority for concessions',
    })
  }

  if (subject.language !== subject.preferredLanguage) {
    findings.push({
      ruleId: 'REVIEW_LANGUAGE_MISMATCH',
      severity: 'REVISE',
      detail: `drafted in ${subject.language} for a ${subject.preferredLanguage} speaker`,
    })
  }

  if (subject.body.trim().length === 0) {
    findings.push({
      ruleId: 'REVIEW_EMPTY_BODY',
      severity: 'BLOCK',
      detail: 'an empty message would still consume a contact against the frequency cap',
    })
  }

  if (subject.body.length > MAX_BODY_LENGTH) {
    findings.push({
      ruleId: 'REVIEW_LENGTH',
      severity: 'REVISE',
      detail: `body is ${subject.body.length} characters, over the ${MAX_BODY_LENGTH} limit`,
    })
  }

  const blocking = findings.find((finding) => finding.severity === 'BLOCK')
  if (blocking !== undefined) {
    return { verdict: 'BLOCK', reason: blocking.detail, findings }
  }

  return { verdict: 'PASS', reason: findings[0]?.detail, findings }
}

export function reviewFailingClosed(subject: ReviewSubject): ReviewOutcome {
  try {
    return review(subject)
  } catch (cause) {
    return {
      verdict: 'BLOCK',
      reason: `reviewer threw (${cause instanceof Error ? cause.message : 'unknown'}); failing closed`,
      findings: [],
    }
  }
}
