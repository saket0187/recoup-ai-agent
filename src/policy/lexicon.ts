export interface LexiconHit {
  readonly term: string
  readonly index: number
}

function scan(text: string, patterns: readonly RegExp[]): LexiconHit | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null) return { term: match[0], index: match.index }
  }
  return undefined
}

const THREAT_PATTERNS: readonly RegExp[] = [
  /\bwe will (?:seize|confiscate|repossess|take)\b/i,
  /\b(?:police|fir|arrest|jail|criminal case)\b/i,
  /\bconsequences will\b/i,
  /\bwe will (?:come|visit|send someone) to your\b/i,
  /\bblacklist(?:ed)?\b/i,
  /\bruin your\b/i,
  /\bghar (?:aa|aayenge|aayege)\b/i,
  /\bdekh lenge\b/i,
]

const SHAME_PATTERNS: readonly RegExp[] = [
  /\b(?:inform|tell|notify) your (?:employer|family|friends|neighbours|neighbors|colleagues)\b/i,
  /\bdefaulter list\b/i,
  /\bpublicly\b.{0,20}\b(?:list|name|post)\b/i,
  /\bshame\b/i,
  /\beveryone will know\b/i,
  /\bbadnaam\b/i,
]

const LEGAL_AUTHORITY_PATTERNS: readonly RegExp[] = [
  /\blegal notice\b/i,
  /\bcourt (?:summons|order|proceedings)\b/i,
  /\bwe are (?:lawyers|advocates|the court)\b/i,
  /\bsection \d+ of the\b/i,
  /\blawsuit\b/i,
  /\bprosecut(?:e|ion)\b/i,
]

const DARK_PATTERN_PATTERNS: readonly RegExp[] = [
  /\blast chance\b/i,
  /\bfinal warning\b/i,
  /\bexpires in \d+ minutes?\b/i,
  /\bonly \d+ (?:spots|slots) left\b/i,
  /\bact now or\b/i,
]

export function findThreat(text: string): LexiconHit | undefined {
  return scan(text, THREAT_PATTERNS)
}

export function findShaming(text: string): LexiconHit | undefined {
  return scan(text, SHAME_PATTERNS)
}

export function findLegalAuthorityClaim(text: string): LexiconHit | undefined {
  return scan(text, LEGAL_AUTHORITY_PATTERNS)
}

export function findDarkPattern(text: string): LexiconHit | undefined {
  return scan(text, DARK_PATTERN_PATTERNS)
}
