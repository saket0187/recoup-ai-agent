import { readFileSync } from 'node:fs'

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { istDateKey } from './calendar'

import { ACTION_TYPES, CHANNELS, POLICY_VERDICTS } from '../domain/enums'

export class ConfigFileError extends Error {
  override readonly name = 'ConfigFileError'
}

function load<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new ConfigFileError(
      `Cannot read ${path}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    )
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new ConfigFileError(`Invalid configuration in ${path}:\n${detail}`)
  }
  return parsed.data
}

const rungSchema = z.object({
  name: z.string().min(1),
  min_dwell_days: z.number().int().nonnegative(),
})

const authoritySchema = z.object({
  authority_version: z.string().min(1),
  discount: z.object({
    max_pct: z.number().min(0).max(100),
    max_paise: z.number().int().nonnegative(),
  }),
  extension: z.object({ max_days: z.number().int().nonnegative() }),
  promises: z.object({
    max_per_case: z.number().int().nonnegative(),
    grace_hours: z.number().int().nonnegative(),
  }),
  budgets: z.object({
    max_touches_per_case: z.number().int().positive(),
    max_retries_per_case: z.number().int().positive(),
    max_ptp_per_case: z.number().int().nonnegative(),
  }),
  allocation: z.object({
    max_actions_per_cycle: z.number().int().positive(),
    max_contacts_per_cycle: z.number().int().positive(),
    max_spend_per_cycle_paise: z.number().int().positive(),
  }),
  thresholds: z.object({
    auto_write_off_below_paise: z.number().int().nonnegative(),
    human_approval_required_above_paise: z.number().int().positive(),
    case_age_limit_days: z.number().int().positive(),
  }),
  cadence: z.object({
    after_execute_hours: z.number().positive(),
    after_wait_hours: z.number().positive(),
    attribution_window_hours: z.number().positive(),
  }),
  escalation: z.object({ rungs: z.array(rungSchema).min(1) }),
})

const costEntrySchema = z.object({
  direct_paise: z.number().int().nonnegative(),
  annoyance_paise: z.number().int().nonnegative().optional(),
  risk_paise: z.number().int().nonnegative().optional(),
})

const costsSchema = z.object({
  costs_version: z.string().min(1),
  margin_rate_bp: z.number().int().min(0).max(10_000),
  channels: z.partialRecord(z.enum(CHANNELS), costEntrySchema),
  actions: z.partialRecord(z.enum(ACTION_TYPES), costEntrySchema),
  annoyance_growth_per_touch: z.number().min(1),
})

const groundingSchema = z.object({
  source: z.string().min(1),
  chunk_id: z.string().optional(),
  snippet_hash: z.string().optional(),
  human_verified: z.boolean(),
})

const policyRuleSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'rule ids are SCREAMING_SNAKE_CASE'),
  category: z.enum([
    'timing',
    'consent',
    'frequency',
    'escalation',
    'content',
    'data_protection',
    'money_safety',
  ]),
  applies_to: z.union([z.literal('ALL'), z.literal('ALL_CONTACT'), z.array(z.enum(ACTION_TYPES))]),
  on_fail: z.enum(
    POLICY_VERDICTS.filter((verdict) => verdict !== 'ALLOW') as [string, ...string[]],
  ),
  params: z.record(z.string(), z.unknown()),
  grounding: z.array(groundingSchema).optional(),
})

const policySchema = z.object({
  policy_version: z.string().min(1),
  rules: z.array(policyRuleSchema).min(1),
})

export type AuthorityConfig = z.infer<typeof authoritySchema>
export type CostsConfig = z.infer<typeof costsSchema>
export type PolicyRuleConfig = z.infer<typeof policyRuleSchema>
export type PolicyConfig = z.infer<typeof policySchema>

export function loadAuthority(path = './config/authority.yaml'): AuthorityConfig {
  const config = load(path, authoritySchema)
  if (config.discount.max_pct === 0 && config.discount.max_paise > 0) {
    throw new ConfigFileError(
      `${path}: a discount cap of 0% with a non-zero rupee cap is ambiguous`,
    )
  }
  return config
}

export function loadCosts(path = './config/costs.yaml'): CostsConfig {
  const config = load(path, costsSchema)
  for (const channel of CHANNELS) {
    if (config.channels[channel] === undefined) {
      throw new ConfigFileError(`${path}: no cost entry for channel ${channel}`)
    }
  }
  return config
}

export function loadPolicy(path = './config/policy.yaml'): PolicyConfig {
  const config = load(path, policySchema)
  const seen = new Set<string>()
  for (const rule of config.rules) {
    if (seen.has(rule.id)) throw new ConfigFileError(`${path}: duplicate rule id ${rule.id}`)
    seen.add(rule.id)
  }
  return config
}

const calendarSchema = z.object({
  timezone: z.string().min(1),
  bank_holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  festivals: z.array(
    z.object({
      name: z.string().min(1),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
})

export type CalendarConfig = z.infer<typeof calendarSchema>

export interface RecoveryCalendar {
  readonly bankHolidays: ReadonlySet<string>
  isFestival(at: number): boolean
}

export function loadCalendar(path = './config/calendar.yaml'): RecoveryCalendar {
  const config = load(path, calendarSchema)
  for (const window of config.festivals) {
    if (window.end < window.start) {
      throw new ConfigFileError(`${path}: festival ${window.name} ends before it starts`)
    }
  }
  const bankHolidays = new Set(config.bank_holidays)
  const festivals = config.festivals
  return {
    bankHolidays,
    isFestival(at: number): boolean {
      const key = istDateKey(at)
      return festivals.some((window) => key >= window.start && key <= window.end)
    },
  }
}
