import { z } from 'zod'

import { INBOUND_INTENTS, type InboundIntent } from '../domain/enums'

const extractedIntentSchema = z.object({
  intent: z.enum(INBOUND_INTENTS),
  confidence: z.number().min(0).max(1),
  promisedInDays: z.number().int().min(0).max(60).optional(),
})

export type ExtractedIntent = z.infer<typeof extractedIntentSchema>

const PATTERNS: readonly (readonly [InboundIntent, RegExp, number])[] = [
  ['OPT_OUT', /\b(stop|unsubscribe|do not (contact|message)|opt.?out|band karo)\b/i, 0.95],
  ['ABUSE', /\b(harass\w*|abusive|threaten\w*|consumer court|report you)\b/i, 0.8],
  [
    'DISTRESS',
    /\b(hospital|medical emergency|passed away|died|death|bereave\w*|lost my job|retrench\w*)\b/i,
    0.85,
  ],
  ['WRONG_PERSON', /\b(wrong (number|person)|not me|never had|don'?t know)\b/i, 0.8],
  ['DISPUTE_AMOUNT', /\b(wrong (charge|amount|bill)|overcharg\w*|double charg\w*|refund)\b/i, 0.8],
  [
    'DISPUTE_SERVICE',
    /\b(never (ordered|subscribed)|already cancel\w*|service (not|never) (work|deliver)\w*)\b/i,
    0.8,
  ],
  ['ALREADY_PAID', /\b(already paid|payment done|paid yesterday|transferred|utr|receipt)\b/i, 0.85],
  ['REQUEST_PLAN', /\b(instal?ment|emi|part payment|split|plan|pay in parts)\b/i, 0.8],
  ['REQUEST_HUMAN', /\b(talk to (someone|a human|an agent)|call me|speak to)\b/i, 0.75],
  ['WILL_PAY_NOW', /\b(paying now|doing it now|right away|sending now)\b/i, 0.8],
  ['CANNOT_PAY', /\b(cannot pay|can'?t pay|no money|unable to pay|not possible)\b/i, 0.8],
  [
    'PROMISE_TO_PAY',
    /\b(will pay|i'?ll pay|pay by|pay on|salary|next week|tomorrow|by \d{1,2}(st|nd|rd|th)?|kal)\b/i,
    0.75,
  ],
]

const DAY_HINTS: readonly (readonly [RegExp, number])[] = [
  [/\btomorrow|kal\b/i, 1],
  [/\bday after\b/i, 2],
  [/\bthis week\b/i, 4],
  [/\bnext week\b/i, 7],
  [/\bsalary|month.?end\b/i, 10],
  [/\bnext month\b/i, 21],
]

function promisedDays(body: string): number {
  const explicit = /\bin (\d{1,2}) days?\b/i.exec(body)
  if (explicit?.[1] !== undefined) {
    const parsed = Number.parseInt(explicit[1], 10)
    if (Number.isFinite(parsed)) return Math.min(60, Math.max(0, parsed))
  }

  for (const [pattern, days] of DAY_HINTS) {
    if (pattern.test(body)) return days
  }

  return 7
}

export function extractIntent(body: string): ExtractedIntent {
  for (const [intent, pattern, confidence] of PATTERNS) {
    if (!pattern.test(body)) continue

    return extractedIntentSchema.parse({
      intent,
      confidence,
      ...(intent === 'PROMISE_TO_PAY' ? { promisedInDays: promisedDays(body) } : {}),
    })
  }

  return { intent: 'UNCLEAR', confidence: 0 }
}
