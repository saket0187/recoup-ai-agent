import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../src/core/config'

describe('loadConfig', () => {
  it('defaults to the safe, zero-setup configuration', () => {
    const config = loadConfig({})
    expect(config.dryRun).toBe(true)
    expect(config.killSwitch).toBe(false)
    expect(config.seed).toBe(42)
    expect(config.clockMode).toBe('VIRTUAL')
    expect(config.dbPath).toBe('./data/recoup.db')
    expect(config.logLevel).toBe('info')
  })

  it('treats an empty string as unset', () => {
    expect(loadConfig({ DRY_RUN: '', SEED: '' }).dryRun).toBe(true)
    expect(loadConfig({ SEED: '' }).seed).toBe(42)
  })

  it('accepts the usual boolean spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadConfig({ KILL_SWITCH: value }).killSwitch).toBe(true)
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(loadConfig({ KILL_SWITCH: value }).killSwitch).toBe(false)
    }
  })

  it('rejects a boolean it cannot interpret rather than guessing', () => {
    expect(() => loadConfig({ DRY_RUN: 'maybe' })).toThrow(ConfigError)
  })

  it('refuses live mode without an explicit confirmation', () => {
    expect(() => loadConfig({ DRY_RUN: 'false' })).toThrow(/LIVE_CONFIRM/)
    expect(() => loadConfig({ DRY_RUN: 'false', LIVE_CONFIRM: 'yes' })).toThrow(/LIVE_CONFIRM/)
  })

  it('allows live mode when both signals are present', () => {
    const config = loadConfig({ DRY_RUN: 'false', LIVE_CONFIRM: 'I_UNDERSTAND' })
    expect(config.dryRun).toBe(false)
  })

  it('refuses a real model client with no key', () => {})

  it('rejects a non-integer or out-of-range seed', () => {
    expect(() => loadConfig({ SEED: '4.2' })).toThrow(ConfigError)
    expect(() => loadConfig({ SEED: '-1' })).toThrow(ConfigError)
  })

  it('rejects an unknown log level and clock mode', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'trace' })).toThrow(ConfigError)
    expect(() => loadConfig({ CLOCK_MODE: 'FAST' })).toThrow(ConfigError)
  })
})
