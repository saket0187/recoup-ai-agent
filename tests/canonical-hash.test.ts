import { describe, expect, it } from 'vitest'

import { GENESIS_HASH, canonicalJson, hashRecord, sha256 } from '../src/core/canonical-hash'

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested keys too', () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } }
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })

  it('omits undefined properties rather than emitting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('rejects a bare undefined', () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined/)
  })

  it('rejects NaN and Infinity, which mean a division went wrong upstream', () => {
    expect(() => canonicalJson({ ev: Number.NaN })).toThrow(/not representable/)
    expect(() => canonicalJson({ ev: Number.POSITIVE_INFINITY })).toThrow(/not representable/)
  })

  it('rejects a Date so audited records stay in epoch milliseconds', () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/Date is not representable/)
  })

  it('rejects circular references', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node.self = node
    expect(() => canonicalJson(node)).toThrow(/circular/)
  })

  it('normalises negative zero', () => {
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}')
  })

  it('handles the primitives', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson('a"b')).toBe('"a\\"b"')
    expect(canonicalJson(12n)).toBe('"12"')
  })

  it('allows the same object to appear twice in a tree', () => {
    const shared = { a: 1 }
    expect(canonicalJson({ left: shared, right: shared })).toBe('{"left":{"a":1},"right":{"a":1}}')
  })
})

describe('hashRecord', () => {
  it('produces a stable 64-character digest', () => {
    const hash = hashRecord(GENESIS_HASH, { seq: 1, actor: 'system' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRecord(GENESIS_HASH, { actor: 'system', seq: 1 })).toBe(hash)
  })

  it('changes when the record changes', () => {
    const a = hashRecord(GENESIS_HASH, { seq: 1 })
    const b = hashRecord(GENESIS_HASH, { seq: 2 })
    expect(a).not.toBe(b)
  })

  it('changes when the previous hash changes, which is what links the chain', () => {
    const a = hashRecord(GENESIS_HASH, { seq: 1 })
    const b = hashRecord(sha256('other'), { seq: 1 })
    expect(a).not.toBe(b)
  })

  it('has a genesis hash of 64 zeroes', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64))
  })
})
