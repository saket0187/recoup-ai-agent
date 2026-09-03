import { describe, expect, it } from 'vitest'

import { DAY, HOUR, VirtualClock } from '../src/core/clock'

describe('VirtualClock', () => {
  it('starts at the configured instant and reports it', () => {
    const clock = new VirtualClock({ start: 1_700_000_000_000 })
    expect(clock.now()).toBe(1_700_000_000_000)
  })

  it('fires tasks in time order regardless of insertion order', async () => {
    const clock = new VirtualClock()
    const fired: string[] = []

    clock.schedule(300, () => void fired.push('third'))
    clock.schedule(100, () => void fired.push('first'))
    clock.schedule(200, () => void fired.push('second'))

    await clock.runUntilIdle()

    expect(fired).toEqual(['first', 'second', 'third'])
  })

  it('breaks ties by insertion order so a seed replays identically', async () => {
    const clock = new VirtualClock()
    const fired: number[] = []

    for (let i = 0; i < 8; i++) {
      clock.schedule(500, () => void fired.push(i))
    }

    await clock.runUntilIdle()

    expect(fired).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('sets now() to each task instant as it fires', async () => {
    const clock = new VirtualClock()
    const observed: number[] = []

    clock.schedule(100, () => void observed.push(clock.now()))
    clock.schedule(250, () => void observed.push(clock.now()))

    await clock.runUntilIdle()

    expect(observed).toEqual([100, 250])
  })

  it('processes tasks scheduled from inside a running task', async () => {
    const clock = new VirtualClock()
    const fired: string[] = []

    clock.schedule(100, () => {
      fired.push('outer')
      clock.schedule(150, () => void fired.push('inner'))
    })

    await clock.runUntilIdle()

    expect(fired).toEqual(['outer', 'inner'])
    expect(clock.now()).toBe(150)
  })

  it('advances to the target even when no task sits there', async () => {
    const clock = new VirtualClock()
    clock.schedule(100, () => {})

    const fired = await clock.advanceTo(5_000)

    expect(fired).toBe(1)
    expect(clock.now()).toBe(5_000)
  })

  it('leaves tasks beyond the horizon pending', async () => {
    const clock = new VirtualClock()
    clock.schedule(100, () => {})
    clock.schedule(10_000, () => {})

    await clock.advanceTo(1_000)

    expect(clock.pending).toBe(1)
    expect(clock.nextAt()).toBe(10_000)
  })

  it('does not fire a cancelled task', async () => {
    const clock = new VirtualClock()
    const fired: string[] = []

    const task = clock.schedule(100, () => void fired.push('cancelled'))
    clock.schedule(200, () => void fired.push('kept'))

    expect(clock.cancel(task)).toBe(true)
    expect(clock.cancel(task)).toBe(false)

    await clock.runUntilIdle()

    expect(fired).toEqual(['kept'])
  })

  it('supports cancelling one task from inside another', async () => {
    const clock = new VirtualClock()
    const fired: string[] = []

    const later = clock.schedule(200, () => void fired.push('later'))
    clock.schedule(100, () => {
      clock.cancel(later)
    })

    await clock.runUntilIdle()

    expect(fired).toEqual([])
  })

  it('refuses to schedule into the past', () => {
    const clock = new VirtualClock({ start: 1_000 })
    expect(() => clock.schedule(999, () => {}, 'stale-deadline')).toThrow(/before now/)
    expect(() => clock.schedule(1_000, () => {})).not.toThrow()
  })

  it('refuses to move backwards', async () => {
    const clock = new VirtualClock({ start: 1_000 })
    await expect(clock.advanceTo(500)).rejects.toThrow(/backwards/)
  })

  it('rejects a re-entrant advance from inside a task', async () => {
    const clock = new VirtualClock()
    clock.schedule(100, async () => {
      await clock.advanceBy(50)
    })

    await expect(clock.runUntilIdle()).rejects.toThrow(/re-entrant/)
  })

  it('stops a task that reschedules itself without advancing time', async () => {
    const clock = new VirtualClock({ maxSteps: 50 })
    const spin = (): void => {
      clock.schedule(clock.now(), spin)
    }
    clock.schedule(0, spin)

    await expect(clock.runUntilIdle()).rejects.toThrow(/exceeded 50 steps/)
  })

  it('awaits async tasks before moving on', async () => {
    const clock = new VirtualClock()
    const order: string[] = []

    clock.schedule(100, async () => {
      await Promise.resolve()
      order.push('slow')
    })
    clock.schedule(200, () => void order.push('after'))

    await clock.runUntilIdle()

    expect(order).toEqual(['slow', 'after'])
  })

  it('replays a multi-day schedule in order', async () => {
    const clock = new VirtualClock({ start: 0 })
    const fired: number[] = []

    for (let day = 45; day >= 1; day--) {
      clock.schedule(day * DAY + 10 * HOUR, () => void fired.push(day))
    }

    await clock.runUntilIdle()

    expect(fired).toEqual(Array.from({ length: 45 }, (_, i) => i + 1))
    expect(clock.now()).toBe(45 * DAY + 10 * HOUR)
  })
})
