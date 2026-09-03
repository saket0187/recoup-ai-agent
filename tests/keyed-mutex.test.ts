import { describe, expect, it } from 'vitest'

import { KeyedMutex } from '../src/core/keyed-mutex'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('KeyedMutex', () => {
  it('runs work for one key strictly in order', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []

    const first = mutex.run('case_1', async () => {
      order.push('first:start')
      await Promise.resolve()
      order.push('first:end')
    })
    const second = mutex.run('case_1', async () => {
      order.push('second:start')
      order.push('second:end')
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('does not make one key wait on another', async () => {
    const mutex = new KeyedMutex()
    const blocker = deferred<void>()
    const finished: string[] = []

    const slow = mutex.run('case_1', async () => {
      await blocker.promise
      finished.push('slow')
    })
    await mutex.run('case_2', async () => {
      finished.push('fast')
    })

    expect(finished).toEqual(['fast'])
    blocker.resolve()
    await slow
    expect(finished).toEqual(['fast', 'slow'])
  })

  it('serialises a read-modify-write that would otherwise interleave', async () => {
    const mutex = new KeyedMutex()
    let shared = 0

    const increment = (): Promise<void> =>
      mutex.run('case_1', async () => {
        const seen = shared
        await Promise.resolve()
        shared = seen + 1
      })

    await Promise.all(Array.from({ length: 50 }, increment))
    expect(shared).toBe(50)
  })

  it('keeps running later work after earlier work rejects', async () => {
    const mutex = new KeyedMutex()

    const failed = mutex.run('case_1', () => Promise.reject(new Error('boom')))
    await expect(failed).rejects.toThrow('boom')

    await expect(mutex.run('case_1', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('surfaces a rejection to its own caller rather than to the next one', async () => {
    const mutex = new KeyedMutex()

    const first = mutex.run('case_1', () => Promise.reject(new Error('first failed')))
    const second = mutex.run('case_1', () => Promise.resolve('second ok'))

    await expect(first).rejects.toThrow('first failed')
    await expect(second).resolves.toBe('second ok')
  })

  it('returns the value the work produced', async () => {
    const mutex = new KeyedMutex()
    await expect(mutex.run('k', () => Promise.resolve(42))).resolves.toBe(42)
  })

  it('holds a key while work is in flight', async () => {
    const mutex = new KeyedMutex()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = mutex.run('a', () => gate)
    expect(mutex.held).toBe(1)

    release()
    await running
  })

  it('releases every key once the work settles, so it cannot leak', async () => {
    const mutex = new KeyedMutex()
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => mutex.run(`key_${i}`, () => Promise.resolve(i))),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(mutex.held).toBe(0)
  })

  it('releases a key even when the work threw', async () => {
    const mutex = new KeyedMutex()
    await mutex.run('a', () => Promise.reject(new Error('boom'))).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(mutex.held).toBe(0)
  })
})
