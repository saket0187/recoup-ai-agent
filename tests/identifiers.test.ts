import { describe, expect, it } from 'vitest'

import { createIdFactory, idempotencyKey } from '../src/core/identifiers'

describe('createIdFactory', () => {
  it('produces prefixed, ordered identifiers', () => {
    const ids = createIdFactory('run-1')
    expect(ids.next('case')).toMatch(/^case_[0-9a-f]{6}[0-9a-z]{6}$/)
    expect(ids.count('case')).toBe(1)
  })

  it('replays identically for the same run key', () => {
    const a = createIdFactory('run-1')
    const b = createIdFactory('run-1')
    expect(Array.from({ length: 5 }, () => a.next('case'))).toEqual(
      Array.from({ length: 5 }, () => b.next('case')),
    )
  })

  it('separates runs so two seeds do not collide in one database', () => {
    expect(createIdFactory('run-1').next('case')).not.toBe(createIdFactory('run-2').next('case'))
  })

  it('counts each prefix independently', () => {
    const ids = createIdFactory('run-1')
    ids.next('case')
    ids.next('case')
    ids.next('decision')
    expect(ids.count('case')).toBe(2)
    expect(ids.count('decision')).toBe(1)
    expect(ids.count('action')).toBe(0)
  })

  it('never repeats an identifier within a run', () => {
    const ids = createIdFactory('run-1')
    const seen = new Set(Array.from({ length: 5_000 }, () => ids.next('case')))
    expect(seen.size).toBe(5_000)
  })
})

describe('idempotencyKey', () => {
  it('is stable for the same inputs', () => {
    expect(idempotencyKey('case_1', 'RETRY_CHARGE', 3)).toBe(
      idempotencyKey('case_1', 'RETRY_CHARGE', 3),
    )
  })

  it('changes when any part changes', () => {
    const base = idempotencyKey('case_1', 'RETRY_CHARGE', 3)
    expect(idempotencyKey('case_1', 'RETRY_CHARGE', 4)).not.toBe(base)
    expect(idempotencyKey('case_2', 'RETRY_CHARGE', 3)).not.toBe(base)
    expect(idempotencyKey('case_1', 'SEND_NUDGE', 3)).not.toBe(base)
  })

  it('does not collide across differently split parts', () => {
    expect(idempotencyKey('ab', 'c')).not.toBe(idempotencyKey('a', 'bc'))
  })

  it('requires at least one part', () => {
    expect(() => idempotencyKey()).toThrow()
  })
})
