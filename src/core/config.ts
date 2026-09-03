import { z } from 'zod'
import type { ClockMode } from './clock'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return defaultValue
      const normalised = raw.trim().toLowerCase()
      if (TRUE_VALUES.has(normalised)) return true
      if (FALSE_VALUES.has(normalised)) return false
      ctx.addIssue({
        code: 'custom',
        message: `expected one of true/false/1/0/yes/no/on/off, got "${raw}"`,
      })
      return z.NEVER
    })
}

function envInteger(defaultValue: number, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return defaultValue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `expected an integer in [${min}, ${max}], got "${raw}"`,
        })
        return z.NEVER
      }
      return parsed
    })
}

function envString(defaultValue: string) {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? defaultValue : raw.trim()))
}

function optionalSecret() {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? undefined : raw.trim()))
}

const LIVE_CONFIRMATION_PHRASE = 'I_UNDERSTAND'

const envSchema = z.object({
  DRY_RUN: envBoolean(true),
  LIVE_CONFIRM: optionalSecret(),
  KILL_SWITCH: envBoolean(false),
  SEED: envInteger(42, 0, Number.MAX_SAFE_INTEGER),
  CLOCK_MODE: z.enum(['VIRTUAL', 'REAL']).optional().default('VIRTUAL'),
  DB_PATH: envString('./data/recoup.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
})

export interface AppConfig {
  readonly dryRun: boolean
  readonly killSwitch: boolean
  readonly seed: number
  readonly clockMode: ClockMode
  readonly dbPath: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`Invalid environment configuration:\n${details}`)
  }

  const env = parsed.data

  if (!env.DRY_RUN && env.LIVE_CONFIRM !== LIVE_CONFIRMATION_PHRASE) {
    throw new ConfigError(
      `DRY_RUN is false but LIVE_CONFIRM is not set to "${LIVE_CONFIRMATION_PHRASE}". ` +
        `Live mode sends real messages and moves real money; it requires both.`,
    )
  }

  return {
    dryRun: env.DRY_RUN,
    killSwitch: env.KILL_SWITCH,
    seed: env.SEED,
    clockMode: env.CLOCK_MODE,
    dbPath: env.DB_PATH,
    logLevel: env.LOG_LEVEL,
  }
}

function loadEnvFile(path = '.env'): void {
  try {
    process.loadEnvFile(path)
  } catch {
    return
  }
}

let cached: AppConfig | undefined

export function getConfig(): AppConfig {
  if (cached === undefined) {
    loadEnvFile()
    cached = loadConfig(process.env)
  }
  return cached
}
