import { describe, expect, it } from 'vitest'

import { fromIst, istDateKey } from '../src/core/calendar'
import {
  WorldConfigError,
  downtimeSeverity,
  isCohortDown,
  loadWorldTimeline,
  parseWorldTimeline,
  worldStateAt,
} from '../src/sim/world'

const MINIMAL = `
timezone: Asia/Kolkata
start_date: "2026-09-01"
duration_days: 10
events:
  - kind: gateway_downtime
    name: HDFC UPI degradation
    method: upi
    issuer: HDFC
    start: day 3 14:20
    end: day 3 16:05
    severity: 0.9
`

describe('parseWorldTimeline', () => {
  it('resolves day offsets against the start date, with day 1 as the first day', () => {
    const timeline = parseWorldTimeline(MINIMAL)
    const event = timeline.events[0]

    expect(event).toBeDefined()
    expect(event?.startAt).toBe(fromIst(2026, 9, 3, 14, 20))
    expect(event?.endAt).toBe(fromIst(2026, 9, 3, 16, 5))
  })

  it('sets the window from start date and duration', () => {
    const timeline = parseWorldTimeline(MINIMAL)
    expect(timeline.startAt).toBe(fromIst(2026, 9, 1))
    expect(istDateKey(timeline.endAt)).toBe('2026-09-11')
    expect(timeline.durationDays).toBe(10)
  })

  it('rejects an unparseable time specification', () => {
    expect(() => parseWorldTimeline(MINIMAL.replace('day 3 14:20', 'tuesday afternoon'))).toThrow(
      WorldConfigError,
    )
  })

  it('rejects an event that ends before it starts', () => {
    expect(() => parseWorldTimeline(MINIMAL.replace('day 3 16:05', 'day 3 10:00'))).toThrow(
      /ends at or before it starts/,
    )
  })

  it('rejects a downtime with no method', () => {
    expect(() => parseWorldTimeline(MINIMAL.replace('    method: upi\n', ''))).toThrow(
      /must name a method/,
    )
  })

  it('rejects an unknown event kind', () => {
    expect(() => parseWorldTimeline(MINIMAL.replace('gateway_downtime', 'solar_flare'))).toThrow(
      WorldConfigError,
    )
  })

  it('collects bank holidays as date keys', () => {
    const timeline = parseWorldTimeline(`
timezone: Asia/Kolkata
start_date: "2026-09-01"
duration_days: 10
events:
  - kind: bank_holiday
    name: Public holiday
    start: day 7 00:00
    end: day 7 23:59
`)
    expect([...timeline.bankHolidays]).toEqual(['2026-09-07'])
  })
})

describe('worldStateAt', () => {
  const timeline = parseWorldTimeline(MINIMAL)
  const during = fromIst(2026, 9, 3, 15, 0)
  const before = fromIst(2026, 9, 3, 14, 0)
  const after = fromIst(2026, 9, 3, 17, 0)

  it('reports a downtime only inside its window', () => {
    expect(worldStateAt(timeline, during).downtimes).toHaveLength(1)
    expect(worldStateAt(timeline, before).downtimes).toHaveLength(0)
    expect(worldStateAt(timeline, after).downtimes).toHaveLength(0)
  })

  it('treats the window as half-open so the resolve instant is already clear', () => {
    expect(worldStateAt(timeline, fromIst(2026, 9, 3, 14, 20)).downtimes).toHaveLength(1)
    expect(worldStateAt(timeline, fromIst(2026, 9, 3, 16, 5)).downtimes).toHaveLength(0)
  })

  it('scopes the outage to the affected cohort only', () => {
    const state = worldStateAt(timeline, during)
    expect(isCohortDown(state, 'upi', 'HDFC')).toBe(true)
    expect(isCohortDown(state, 'upi', 'ICICI')).toBe(false)
    expect(isCohortDown(state, 'card', 'HDFC')).toBe(false)
    expect(downtimeSeverity(state, 'upi', 'HDFC')).toBe(0.9)
  })
})

describe('the committed world fixture', () => {
  const timeline = loadWorldTimeline()

  it('loads and covers the planned window', () => {
    expect(timeline.durationDays).toBe(45)
    expect(timeline.events.length).toBeGreaterThanOrEqual(4)
  })

  it('contains the HDFC UPI outage on day 3 from 14:20 to 16:05', () => {
    const outage = timeline.events.find((event) => event.issuer === 'HDFC')
    expect(outage?.startAt).toBe(fromIst(2026, 9, 3, 14, 20))
    expect(outage?.endAt).toBe(fromIst(2026, 9, 3, 16, 5))
  })

  it('contains a merchant defect window of forty minutes on day 5', () => {
    const defect = timeline.events.find((event) => event.kind === 'merchant_defect')
    expect(defect?.reason).toBe('input_validation_failed')
    expect((defect?.endAt ?? 0) - (defect?.startAt ?? 0)).toBe(40 * 60_000)
  })

  it('contains a festival week spanning days 12 to 16', () => {
    const state = worldStateAt(timeline, fromIst(2026, 9, 14, 12))
    expect(state.isFestival).toBe(true)
    expect(worldStateAt(timeline, fromIst(2026, 9, 11, 12)).isFestival).toBe(false)
  })

  it('marks the merchant defect only inside its window', () => {
    expect(worldStateAt(timeline, fromIst(2026, 9, 5, 11, 20)).merchantDefect).toBeDefined()
    expect(worldStateAt(timeline, fromIst(2026, 9, 5, 12, 0)).merchantDefect).toBeUndefined()
  })
})
