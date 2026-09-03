export type ClockMode = 'REAL' | 'VIRTUAL'

export type TaskFn = () => void | Promise<void>

export interface ScheduledTask {
  readonly id: number
  readonly at: number
  readonly label: string
}

export interface Clock {
  readonly mode: ClockMode
  now(): number
  schedule(at: number, fn: TaskFn, label?: string): ScheduledTask
  cancel(task: ScheduledTask | number): boolean
}

interface HeapEntry {
  id: number
  at: number
  seq: number
  fn: TaskFn
  label: string
  cancelled: boolean
}

function precedes(a: HeapEntry, b: HeapEntry): boolean {
  return a.at !== b.at ? a.at < b.at : a.seq < b.seq
}

class TaskHeap {
  private items: HeapEntry[] = []

  get size(): number {
    return this.items.length
  }

  peek(): HeapEntry | undefined {
    return this.items[0]
  }

  push(entry: HeapEntry): void {
    const items = this.items
    items.push(entry)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      const a = items[i]
      const b = items[parent]
      if (a === undefined || b === undefined || !precedes(a, b)) break
      items[i] = b
      items[parent] = a
      i = parent
    }
  }

  pop(): HeapEntry | undefined {
    const items = this.items
    const top = items[0]
    if (top === undefined) return undefined
    const last = items.pop()
    if (items.length > 0 && last !== undefined) {
      items[0] = last
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        const atSmallest = items[smallest]
        const atLeft = items[left]
        const atRight = items[right]
        if (atLeft !== undefined && atSmallest !== undefined && precedes(atLeft, atSmallest)) {
          smallest = left
        }
        const atNewSmallest = items[smallest]
        if (
          atRight !== undefined &&
          atNewSmallest !== undefined &&
          precedes(atRight, atNewSmallest)
        ) {
          smallest = right
        }
        if (smallest === i) break
        const a = items[i]
        const b = items[smallest]
        if (a === undefined || b === undefined) break
        items[i] = b
        items[smallest] = a
        i = smallest
      }
    }
    return top
  }
}

export interface VirtualClockOptions {
  start?: number
  maxSteps?: number
}

export class VirtualClock implements Clock {
  readonly mode = 'VIRTUAL' as const

  private heap = new TaskHeap()
  private live = new Map<number, HeapEntry>()
  private current: number
  private nextId = 1
  private nextSeq = 0
  private readonly maxSteps: number
  private draining = false

  constructor(options: VirtualClockOptions = {}) {
    this.current = options.start ?? 0
    this.maxSteps = options.maxSteps ?? 5_000_000
  }

  now(): number {
    return this.current
  }

  get pending(): number {
    return this.live.size
  }

  nextAt(): number | undefined {
    for (;;) {
      const top = this.heap.peek()
      if (top === undefined) return undefined
      if (!top.cancelled) return top.at
      this.heap.pop()
    }
  }

  schedule(at: number, fn: TaskFn, label = 'task'): ScheduledTask {
    if (!Number.isFinite(at)) {
      throw new RangeError(`VirtualClock.schedule: "at" must be finite, got ${at}`)
    }
    if (at < this.current) {
      throw new RangeError(
        `VirtualClock.schedule: cannot schedule "${label}" at ${at}, which is before now (${this.current}). ` +
          `Scheduling into the past means a caller computed a deadline from stale state.`,
      )
    }
    const entry: HeapEntry = {
      id: this.nextId++,
      at,
      seq: this.nextSeq++,
      fn,
      label,
      cancelled: false,
    }
    this.heap.push(entry)
    this.live.set(entry.id, entry)
    return { id: entry.id, at: entry.at, label: entry.label }
  }

  scheduleIn(delay: number, fn: TaskFn, label?: string): ScheduledTask {
    return this.schedule(this.current + delay, fn, label)
  }

  cancel(task: ScheduledTask | number): boolean {
    const id = typeof task === 'number' ? task : task.id
    const entry = this.live.get(id)
    if (entry === undefined) return false
    entry.cancelled = true
    this.live.delete(id)
    return true
  }

  async advanceTo(target: number): Promise<number> {
    if (!Number.isFinite(target)) {
      throw new RangeError(`VirtualClock.advanceTo: target must be finite, got ${target}`)
    }
    if (target < this.current) {
      throw new RangeError(
        `VirtualClock.advanceTo: cannot move backwards from ${this.current} to ${target}.`,
      )
    }
    const fired = await this.drain(target)
    if (target > this.current) this.current = target
    return fired
  }

  advanceBy(delta: number): Promise<number> {
    return this.advanceTo(this.current + delta)
  }

  runUntilIdle(): Promise<number> {
    return this.drain(Number.POSITIVE_INFINITY)
  }

  private async drain(horizon: number): Promise<number> {
    if (this.draining) {
      throw new Error(
        'VirtualClock: re-entrant advance. Do not advance the clock from inside a task.',
      )
    }
    this.draining = true
    let fired = 0
    try {
      for (;;) {
        const top = this.heap.peek()
        if (top === undefined || top.at > horizon) break
        this.heap.pop()
        if (top.cancelled) continue
        this.live.delete(top.id)
        this.current = top.at
        fired++
        if (fired > this.maxSteps) {
          throw new Error(
            `VirtualClock: exceeded ${this.maxSteps} steps while draining to ${horizon}. ` +
              `A task is almost certainly rescheduling itself without advancing time.`,
          )
        }
        await top.fn()
      }
    } finally {
      this.draining = false
    }
    return fired
  }
}

export class RealClock implements Clock {
  readonly mode = 'REAL' as const

  private timers = new Map<number, ReturnType<typeof setTimeout>>()
  private nextId = 1

  now(): number {
    return Date.now()
  }

  schedule(at: number, fn: TaskFn, label = 'task'): ScheduledTask {
    const id = this.nextId++
    const delay = Math.max(0, at - this.now())
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void fn()
    }, delay)
    this.timers.set(id, timer)
    return { id, at, label }
  }

  cancel(task: ScheduledTask | number): boolean {
    const id = typeof task === 'number' ? task : task.id
    const timer = this.timers.get(id)
    if (timer === undefined) return false
    clearTimeout(timer)
    this.timers.delete(id)
    return true
  }
}

const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
