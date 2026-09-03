import { createHash } from 'node:crypto'

export type Canonical =
  string | number | boolean | null | readonly Canonical[] | { readonly [key: string]: Canonical }

export function canonicalJson(value: unknown): string {
  return stringify(value, new WeakSet())
}

function stringify(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `canonicalJson(): ${value} is not representable. A NaN or Infinity on an audited record means a division went wrong upstream.`,
        )
      }
      return Object.is(value, -0) ? '0' : String(value)
    }
    case 'bigint':
      return `"${value.toString()}"`
    case 'undefined':
      throw new TypeError('canonicalJson(): undefined is not representable; omit the key instead')
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson(): ${typeof value} is not representable`)
    case 'object':
      break
  }

  const object: object = value
  if (seen.has(object)) {
    throw new TypeError('canonicalJson(): circular reference')
  }
  seen.add(object)

  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => stringify(item, seen)).join(',')}]`
    }
    if (object instanceof Date) {
      throw new TypeError(
        'canonicalJson(): Date is not representable. Audited records store epoch milliseconds from the Clock.',
      )
    }
    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stringify(item, seen)}`)
      .join(',')
    return `{${body}}`
  } finally {
    seen.delete(object)
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function hashRecord(previousHash: string, record: unknown): string {
  return sha256(previousHash + canonicalJson(record))
}

export const GENESIS_HASH = '0'.repeat(64)
