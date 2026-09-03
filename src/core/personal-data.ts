export type PiiKind = 'EMAIL' | 'CARD' | 'AADHAAR' | 'PHONE' | 'PAN' | 'IFSC' | 'VPA'

export interface PiiFinding {
  kind: PiiKind
  value: string
  start: number
  end: number
}

export interface TokenisedText {
  text: string
  map: Record<string, string>
}

interface Detector {
  kind: PiiKind
  pattern: RegExp
  validate?: (raw: string) => boolean
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48
    let value = code
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

const DETECTORS: readonly Detector[] = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'CARD', pattern: /\b\d(?:[ -]?\d){12,18}\b/g, validate: luhnValid },
  { kind: 'AADHAAR', pattern: /(?<!\d)[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)/g },
  { kind: 'PHONE', pattern: /(?<![\d@])(?:\+?91[- ]?)?[6-9]\d{9}(?!\d)/g },
  { kind: 'PAN', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: 'IFSC', pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { kind: 'VPA', pattern: /\b[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32}\b/g },
]

export function findPii(text: string): PiiFinding[] {
  const found: PiiFinding[] = []
  for (const detector of DETECTORS) {
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags)
    for (;;) {
      const match = pattern.exec(text)
      if (match === null) break
      const raw = match[0]
      if (detector.validate !== undefined && !detector.validate(raw)) continue
      found.push({
        kind: detector.kind,
        value: raw,
        start: match.index,
        end: match.index + raw.length,
      })
    }
  }

  found.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end))

  const kept: PiiFinding[] = []
  let boundary = -1
  for (const finding of found) {
    if (finding.start < boundary) continue
    kept.push(finding)
    boundary = finding.end
  }
  return kept
}

export function tokenisePii(text: string): TokenisedText {
  const findings = findPii(text)
  if (findings.length === 0) return { text, map: {} }

  const map: Record<string, string> = {}
  const assigned = new Map<string, string>()
  const counters = new Map<PiiKind, number>()

  let out = ''
  let cursor = 0
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.value}`
    let token = assigned.get(key)
    if (token === undefined) {
      const n = (counters.get(finding.kind) ?? 0) + 1
      counters.set(finding.kind, n)
      token = `{{${finding.kind}_${n}}}`
      assigned.set(key, token)
      map[token] = finding.value
    }
    out += text.slice(cursor, finding.start) + token
    cursor = finding.end
  }
  out += text.slice(cursor)

  return { text: out, map }
}

export function rehydratePii(text: string, map: Record<string, string>): string {
  let out = text
  for (const [token, value] of Object.entries(map)) {
    out = out.split(token).join(value)
  }
  return out
}

export function assertNoPii(text: string, context: string): void {
  const findings = findPii(text)
  if (findings.length === 0) return
  const kinds = [...new Set(findings.map((f) => f.kind))].join(', ')
  throw new Error(
    `PII_MINIMISATION violated in ${context}: found ${findings.length} item(s) of type ${kinds}. ` +
      `Run the payload through tokenisePii() before it leaves the process.`,
  )
}
