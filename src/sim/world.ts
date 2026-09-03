import { readFileSync } from 'node:fs'

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { addIstDays, fromIst, istDateKey, startOfIstDay } from '../core/calendar'
import { PAYMENT_METHODS, type PaymentMethod } from '../domain/enums'

export const WORLD_EVENT_KINDS = [
  'gateway_downtime',
  'bank_holiday',
  'festival',
  'merchant_defect',
] as const

export type WorldEventKind = (typeof WORLD_EVENT_KINDS)[number]

const OFFSET_PATTERN = /^day\s+(\d+)\s+(\d{2}):(\d{2})$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const eventSchema = z.object({
  kind: z.enum(WORLD_EVENT_KINDS),
  name: z.string().min(1),
  start: z.string().regex(OFFSET_PATTERN, 'expected "day N HH:MM"'),
  end: z.string().regex(OFFSET_PATTERN, 'expected "day N HH:MM"'),
  method: z.enum(PAYMENT_METHODS).optional(),
  issuer: z.string().optional(),
  severity: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
})

const timelineSchema = z.object({
  timezone: z.literal('Asia/Kolkata'),
  start_date: z.string().regex(DATE_PATTERN, 'expected YYYY-MM-DD'),
  duration_days: z.number().int().positive().max(400),
  events: z.array(eventSchema),
})

export interface WorldEvent {
  readonly kind: WorldEventKind
  readonly name: string
  readonly startAt: number
  readonly endAt: number
  readonly method: PaymentMethod | undefined
  readonly issuer: string | undefined
  readonly severity: number
  readonly reason: string | undefined
}

export interface WorldTimeline {
  readonly startAt: number
  readonly endAt: number
  readonly durationDays: number
  readonly events: readonly WorldEvent[]
  readonly bankHolidays: ReadonlySet<string>
}

export interface WorldState {
  readonly at: number
  readonly downtimes: readonly WorldEvent[]
  readonly isBankHoliday: boolean
  readonly isFestival: boolean
  readonly merchantDefect: WorldEvent | undefined
}

export class WorldConfigError extends Error {
  override readonly name = 'WorldConfigError'
}

function resolveOffset(spec: string, startAt: number): number {
  const match = OFFSET_PATTERN.exec(spec)
  if (match === null) throw new WorldConfigError(`Unparseable time specification: "${spec}"`)
  const [, dayText, hourText, minuteText] = match
  const dayIndex = Number(dayText) - 1
  const dayStart = startOfIstDay(addIstDays(startAt, dayIndex))
  return dayStart + Number(hourText) * 3_600_000 + Number(minuteText) * 60_000
}

export function parseWorldTimeline(source: string): WorldTimeline {
  const parsed = timelineSchema.safeParse(parseYaml(source))
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new WorldConfigError(`Invalid world timeline:\n${detail}`)
  }

  const config = parsed.data
  const dateMatch = DATE_PATTERN.exec(config.start_date)
  if (dateMatch === null) throw new WorldConfigError(`Unparseable start_date: ${config.start_date}`)
  const [, year, month, day] = dateMatch
  const startAt = fromIst(Number(year), Number(month), Number(day))
  const endAt = startOfIstDay(addIstDays(startAt, config.duration_days))

  const events: WorldEvent[] = config.events.map((event) => {
    const eventStart = resolveOffset(event.start, startAt)
    const eventEnd = resolveOffset(event.end, startAt)

    if (eventEnd <= eventStart) {
      throw new WorldConfigError(`Event "${event.name}" ends at or before it starts`)
    }
    if (event.kind === 'gateway_downtime' && event.method === undefined) {
      throw new WorldConfigError(`Downtime "${event.name}" must name a method`)
    }

    return {
      kind: event.kind,
      name: event.name,
      startAt: eventStart,
      endAt: eventEnd,
      method: event.method,
      issuer: event.issuer,
      severity: event.severity ?? 1,
      reason: event.reason,
    }
  })

  const bankHolidays = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'bank_holiday') continue
    for (let cursor = event.startAt; cursor < event.endAt; cursor = addIstDays(cursor, 1)) {
      bankHolidays.add(istDateKey(cursor))
    }
  }

  return { startAt, endAt, durationDays: config.duration_days, events, bankHolidays }
}

export function loadWorldTimeline(path = './fixtures/world.yaml'): WorldTimeline {
  return parseWorldTimeline(readFileSync(path, 'utf8'))
}

function isActive(event: WorldEvent, at: number): boolean {
  return at >= event.startAt && at < event.endAt
}

export function worldStateAt(timeline: WorldTimeline, at: number): WorldState {
  const active = timeline.events.filter((event) => isActive(event, at))
  return {
    at,
    downtimes: active.filter((event) => event.kind === 'gateway_downtime'),
    isBankHoliday: active.some((event) => event.kind === 'bank_holiday'),
    isFestival: active.some((event) => event.kind === 'festival'),
    merchantDefect: active.find((event) => event.kind === 'merchant_defect'),
  }
}

export function downtimeSeverity(
  state: WorldState,
  method: PaymentMethod,
  issuer: string | undefined,
): number {
  let severity = 0
  for (const event of state.downtimes) {
    if (event.method !== method) continue
    if (event.issuer !== undefined && event.issuer !== issuer) continue
    severity = Math.max(severity, event.severity)
  }
  return severity
}

export function isCohortDown(
  state: WorldState,
  method: PaymentMethod,
  issuer: string | undefined,
): boolean {
  return downtimeSeverity(state, method, issuer) > 0
}
