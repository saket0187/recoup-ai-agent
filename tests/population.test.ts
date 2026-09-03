import { describe, expect, it } from 'vitest'

import { fromIst } from '../src/core/calendar'
import { createIdFactory } from '../src/core/identifiers'
import { createRng } from '../src/core/seeded-random'
import { ARCHETYPES, profileFor, profilesForPortfolio } from '../src/sim/hidden/archetypes'
import { abilityAt } from '../src/sim/hidden/latent'
import { generatePopulation, summarisePopulation, type SimAccount } from '../src/sim/population'

const START = fromIst(2026, 9, 1)

function build(count = 2_000, seed = 42): SimAccount[] {
  return generatePopulation(createRng(seed), createIdFactory(`pop-${seed}`), {
    merchantId: 'merch_1',
    count,
    startAt: START,
    durationDays: 45,
  })
}

describe('generatePopulation', () => {
  it('generates the requested number of accounts', () => {
    expect(build(2_000)).toHaveLength(2_000)
  })

  it('rejects a non-positive count', () => {
    expect(() => build(0)).toThrow()
  })

  it('replays identically for the same seed', () => {
    const a = summarisePopulation(build(500, 7))
    const b = summarisePopulation(build(500, 7))
    expect(a).toEqual(b)
  })

  it('differs across seeds', () => {
    expect(summarisePopulation(build(500, 7))).not.toEqual(summarisePopulation(build(500, 8)))
  })

  it('gives every account a unique id and external reference', () => {
    const accounts = build(2_000)
    expect(new Set(accounts.map((a) => a.id)).size).toBe(2_000)
    expect(new Set(accounts.map((a) => a.externalRef)).size).toBe(2_000)
  })

  it('spans all three portfolios in roughly the intended mix', () => {
    const summary = summarisePopulation(build(2_000))
    expect(summary.byPortfolio.d2c_subscription / 2_000).toBeCloseTo(0.45, 1)
    expect(summary.byPortfolio.one_time_checkout / 2_000).toBeCloseTo(0.35, 1)
    expect(summary.byPortfolio.b2b_invoice / 2_000).toBeCloseTo(0.2, 1)
  })

  it('seeds every adversarial archetype into the population', () => {
    const summary = summarisePopulation(build(2_000))
    for (const archetype of ARCHETYPES) {
      expect(summary.byArchetype[archetype] ?? 0).toBeGreaterThan(0)
    }
  })

  it('confines the B2B-only archetypes to the B2B portfolio', () => {
    for (const account of build(2_000)) {
      if (account.latent.archetype === 'TDS_DEDUCTOR' || account.latent.archetype === 'AP_CLERK') {
        expect(account.portfolio).toBe('b2b_invoice')
      }
    }
  })

  it('gives every account at least one obligation', () => {
    for (const account of build(500)) {
      expect(account.obligations.length).toBeGreaterThan(0)
    }
  })

  it('keeps every amount a positive whole number of paise within its band', () => {
    for (const account of build(1_000)) {
      for (const obligation of account.obligations) {
        expect(Number.isSafeInteger(obligation.amountPaise)).toBe(true)
        expect(obligation.amountPaise).toBeGreaterThan(0)
      }
    }
  })

  it('prices B2B invoices well above consumer subscriptions', () => {
    const accounts = build(2_000)
    const median = (portfolio: string): number => {
      const amounts = accounts
        .filter((a) => a.portfolio === portfolio)
        .flatMap((a) => a.obligations.map((o) => o.amountPaise))
        .sort((x, y) => x - y)
      return amounts[Math.floor(amounts.length / 2)] ?? 0
    }
    expect(median('b2b_invoice')).toBeGreaterThan(median('d2c_subscription') * 20)
  })

  it('gives subscriptions a repeating monthly schedule', () => {
    const account = build(2_000).find(
      (a) => a.portfolio === 'd2c_subscription' && a.obligations.length > 1,
    )
    expect(account).toBeDefined()
    const dues = (account?.obligations ?? []).map((o) => o.dueAt)
    for (let i = 1; i < dues.length; i++) {
      const gap = (dues[i] ?? 0) - (dues[i - 1] ?? 0)
      expect(gap).toBeGreaterThan(25 * 86_400_000)
      expect(gap).toBeLessThan(35 * 86_400_000)
    }
  })

  it('shares one subscription id across a subscription account’s obligations', () => {
    const account = build(2_000).find(
      (a) => a.portfolio === 'd2c_subscription' && a.obligations.length > 1,
    )
    const ids = new Set((account?.obligations ?? []).map((o) => o.subscriptionId))
    expect(ids.size).toBe(1)
  })

  it('gives every B2B obligation its own invoice id', () => {
    for (const account of build(1_000).filter((a) => a.portfolio === 'b2b_invoice')) {
      const ids = account.obligations.map((o) => o.invoiceId)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.every((id) => id !== undefined)).toBe(true)
    }
  })

  it('records a consent decision for every contactable channel', () => {
    for (const account of build(200)) {
      expect(account.consents.map((c) => c.channel).sort()).toEqual([
        'EMAIL',
        'SMS',
        'VOICE',
        'WHATSAPP',
      ])
    }
  })

  it('gives TDS deductors a rate and nobody else one', () => {
    for (const account of build(2_000)) {
      if (account.latent.behaviour.deductsTds) {
        expect(account.latent.tdsRatePct).not.toBeNull()
      } else {
        expect(account.latent.tdsRatePct).toBeNull()
      }
    }
  })

  it('starts every account with a clean dynamic state', () => {
    for (const account of build(200)) {
      expect(account.dynamic).toEqual({
        annoyanceAccrued: 0,
        optedOut: false,
        cancelled: false,
        promisesMade: 0,
        promisesBroken: 0,
        lastContactAt: null,
      })
    }
  })
})

describe('archetype profiles', () => {
  it('offers every archetype for at least one portfolio', () => {
    for (const archetype of ARCHETYPES) {
      expect(profileFor(archetype).portfolios.length).toBeGreaterThan(0)
    }
  })

  it('rejects an unknown archetype', () => {
    expect(() => profileFor('NOT_AN_ARCHETYPE' as never)).toThrow()
  })

  it('excludes the B2B archetypes from consumer portfolios', () => {
    const ids = profilesForPortfolio('d2c_subscription').map((p) => p.id)
    expect(ids).not.toContain('TDS_DEDUCTOR')
    expect(ids).not.toContain('AP_CLERK')
  })
})

describe('abilityAt', () => {
  const account = (): SimAccount => {
    const found = build(300).find((a) => !a.latent.behaviour.fixedPayCycle)
    if (found === undefined) throw new Error('no non-cyclic account generated')
    return found
  }

  it('rises during the salary window and falls at month end', () => {
    const latent = account().latent
    const payday = abilityAt(latent, fromIst(2026, 9, 2, 12))
    const midMonth = abilityAt(latent, fromIst(2026, 9, 15, 12))
    const monthEnd = abilityAt(latent, fromIst(2026, 9, 29, 12))

    expect(payday).toBeGreaterThanOrEqual(midMonth)
    expect(monthEnd).toBeLessThanOrEqual(midMonth)
  })

  it('stays within [0, 1]', () => {
    for (const acct of build(300)) {
      for (let day = 1; day <= 30; day++) {
        const value = abilityAt(acct.latent, fromIst(2026, 9, day, 12))
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('spikes on the pay cycle for accounts payable teams', () => {
    const clerk = build(2_000).find((a) => a.latent.behaviour.fixedPayCycle)
    expect(clerk).toBeDefined()
    if (clerk === undefined) return

    const payDay = clerk.latent.b2bPayDays[0] ?? 15
    const onCycle = abilityAt(clerk.latent, fromIst(2026, 9, payDay, 12))
    const offCycle = abilityAt(clerk.latent, fromIst(2026, 9, payDay === 20 ? 8 : 20, 12))

    expect(onCycle).toBeGreaterThan(offCycle)
  })
})
