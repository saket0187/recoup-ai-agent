import type { Clock } from './clock'
import { findPii } from './personal-data'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(bindings: LogFields): Logger
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_KEY_PATTERN = /(secret|token|password|api[_-]?key|authorization|signature)/i

const REDACTED = '[redacted]'

function maskPii(value: string): string {
  const findings = findPii(value)
  if (findings.length === 0) return value
  let out = ''
  let cursor = 0
  for (const finding of findings) {
    out += value.slice(cursor, finding.start) + `[${finding.kind}]`
    cursor = finding.end
  }
  return out + value.slice(cursor)
}

function sanitise(key: string, value: unknown, depth: number): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return maskPii(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined) return undefined
  if (value instanceof Error) {
    return { name: value.name, message: maskPii(value.message) }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitise(key, item, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = sanitise(k, v, depth + 1)
      if (cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  if (typeof value === 'symbol') return value.toString()
  return '[unserialisable]'
}

export interface LoggerOptions {
  level?: LogLevel
  clock?: Clock
  bindings?: LogFields
  sink?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const threshold = LEVEL_RANK[level]
  const clock = options.clock
  const bindings = options.bindings ?? {}
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'))

  const emit = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[entryLevel] < threshold) return
    const record: Record<string, unknown> = { level: entryLevel, message: maskPii(message) }
    if (clock !== undefined) record.at = clock.now()
    for (const [key, value] of Object.entries({ ...bindings, ...fields })) {
      const cleaned = sanitise(key, value, 0)
      if (cleaned !== undefined) record[key] = cleaned
    }
    sink(JSON.stringify(record))
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) =>
      createLogger({
        ...options,
        bindings: { ...bindings, ...extra },
      }),
  }
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} })
