export interface Rng {
  readonly label: string
  next(): number
  int(minInclusive: number, maxExclusive: number): number
  bool(probability: number): boolean
  pick<T>(items: readonly T[]): T
  weighted<T>(entries: readonly (readonly [T, number])[]): T
  shuffle<T>(items: readonly T[]): T[]
  sample<T>(items: readonly T[], count: number): T[]
  normal(mean?: number, sd?: number): number
  exponential(rate: number): number
  gamma(shape: number, scale?: number): number
  beta(a: number, b: number): number
  derive(label: string): Rng
}

function hashString(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function elementAt<T>(items: readonly T[], index: number): T {
  if (index < 0 || index >= items.length) {
    throw new RangeError(`Rng: index ${index} is out of range for length ${items.length}`)
  }
  return items[index] as T
}

function normaliseSeed(seed: number | string): number {
  if (typeof seed === 'string') return hashString(seed)
  if (!Number.isFinite(seed)) {
    throw new RangeError(`createRng: seed must be finite, got ${seed}`)
  }
  return Math.abs(Math.trunc(seed)) >>> 0
}

class Mulberry32 implements Rng {
  readonly label: string
  private readonly seed: number
  private state: number

  constructor(seed: number, label: string) {
    this.seed = seed >>> 0
    this.state = this.seed
    this.label = label
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new RangeError('Rng.int: bounds must be integers')
    }
    if (maxExclusive <= minInclusive) {
      throw new RangeError(`Rng.int: empty range [${minInclusive}, ${maxExclusive})`)
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive))
  }

  bool(probability: number): boolean {
    if (probability < 0 || probability > 1) {
      throw new RangeError(`Rng.bool: probability must be in [0,1], got ${probability}`)
    }
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick: empty array')
    return elementAt(items, this.int(0, items.length))
  }

  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    if (entries.length === 0) throw new RangeError('Rng.weighted: empty entries')
    let total = 0
    for (const entry of entries) {
      const weight = entry[1]
      if (weight < 0 || !Number.isFinite(weight)) {
        throw new RangeError(`Rng.weighted: weight must be finite and non-negative, got ${weight}`)
      }
      total += weight
    }
    if (total <= 0) throw new RangeError('Rng.weighted: weights sum to zero')
    let threshold = this.next() * total
    for (const entry of entries) {
      threshold -= entry[1]
      if (threshold < 0) return entry[0]
    }
    return elementAt(entries, entries.length - 1)[0]
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1)
      const a = elementAt(out, i)
      out[i] = elementAt(out, j)
      out[j] = a
    }
    return out
  }

  sample<T>(items: readonly T[], count: number): T[] {
    if (count < 0) throw new RangeError('Rng.sample: count must be non-negative')
    return this.shuffle(items).slice(0, Math.min(count, items.length))
  }

  normal(mean = 0, sd = 1): number {
    let u = 0
    while (u === 0) u = this.next()
    const v = this.next()
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  exponential(rate: number): number {
    if (rate <= 0) throw new RangeError(`Rng.exponential: rate must be positive, got ${rate}`)
    let u = 0
    while (u === 0) u = this.next()
    return -Math.log(u) / rate
  }

  gamma(shape: number, scale = 1): number {
    if (shape <= 0) throw new RangeError(`Rng.gamma: shape must be positive, got ${shape}`)
    if (shape < 1) {
      let u = 0
      while (u === 0) u = this.next()
      return this.gamma(shape + 1, scale) * Math.pow(u, 1 / shape)
    }
    const d = shape - 1 / 3
    const c = 1 / Math.sqrt(9 * d)
    for (;;) {
      const x = this.normal()
      const base = 1 + c * x
      if (base <= 0) continue
      const v = base * base * base
      const u = this.next()
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a)
    const y = this.gamma(b)
    const total = x + y
    return total === 0 ? 0.5 : x / total
  }

  derive(label: string): Rng {
    return new Mulberry32(hashString(`${this.seed}:${this.label}:${label}`), label)
  }
}

export function createRng(seed: number | string, label = 'root'): Rng {
  return new Mulberry32(normaliseSeed(seed), label)
}
