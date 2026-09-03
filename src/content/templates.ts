import { readFileSync } from 'node:fs'

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { istDateKey } from '../core/calendar'
import { formatINR, type Paise } from '../core/money'
import { ACTION_TYPES, LANGUAGES, type ActionType, type Language } from '../domain/enums'
import { RUNGS } from '../policy/escalation'

export class TemplateError extends Error {
  override readonly name = 'TemplateError'
}

const templateSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  actions: z.array(z.enum(ACTION_TYPES)).min(1),
  rung: z.enum(RUNGS),
  includes_offer: z.boolean(),
  bodies: z.partialRecord(z.enum(LANGUAGES), z.string().min(1)),
})

const registrySchema = z.object({
  templates_version: z.string().min(1),
  templates: z.array(templateSchema).min(1),
})

export interface RenderSlots {
  readonly amountPaise: Paise
  readonly merchantName: string
  readonly link: string
  readonly dueAt: number | undefined
  readonly extensionDays: number | undefined
}

export interface RenderedContent {
  readonly templateId: string
  readonly language: Language
  readonly body: string
  readonly amountPaise: Paise
  readonly includesOffer: boolean
}

const SLOT_PATTERN = /\{\{([a-z_]+)\}\}/g

export class TemplateRegistry {
  private readonly version: string
  private readonly byAction = new Map<ActionType, z.infer<typeof templateSchema>>()

  constructor(source: string) {
    const parsed = registrySchema.safeParse(parseYaml(source))
    if (!parsed.success) {
      throw new TemplateError(
        `Invalid template registry:\n${parsed.error.issues
          .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
          .join('\n')}`,
      )
    }

    this.version = parsed.data.templates_version

    for (const template of parsed.data.templates) {
      for (const language of LANGUAGES) {
        if (template.bodies[language] === undefined) {
          throw new TemplateError(
            `Template ${template.id} has no ${language} body. A missing translation would be ` +
              `silently denied by LANGUAGE_MATCH at send time.`,
          )
        }
      }
      for (const action of template.actions) {
        if (this.byAction.has(action)) {
          throw new TemplateError(`Two templates claim action ${action}`)
        }
        this.byAction.set(action, template)
      }
    }
  }

  get templatesVersion(): string {
    return this.version
  }

  has(action: ActionType): boolean {
    return this.byAction.has(action)
  }

  render(action: ActionType, language: Language, slots: RenderSlots): RenderedContent {
    const template = this.byAction.get(action)
    if (template === undefined) {
      throw new TemplateError(`No approved template for ${action}`)
    }

    const body = template.bodies[language]
    if (body === undefined) {
      throw new TemplateError(`Template ${template.id} has no ${language} body`)
    }

    const values: Record<string, string | undefined> = {
      amount: formatINR(slots.amountPaise),
      merchant: slots.merchantName,
      link: slots.link,
      due_date: slots.dueAt === undefined ? undefined : istDateKey(slots.dueAt),
      days: slots.extensionDays === undefined ? undefined : String(slots.extensionDays),
    }

    const missing: string[] = []
    const rendered = body.replace(SLOT_PATTERN, (_match, slot: string) => {
      const value = values[slot]
      if (value === undefined) {
        missing.push(slot)
        return ''
      }
      return value
    })

    if (missing.length > 0) {
      throw new TemplateError(
        `Template ${template.id} needs slots [${missing.join(', ')}] that the caller did not supply. ` +
          `Sending a message with an empty slot is worse than not sending it.`,
      )
    }

    return {
      templateId: template.id,
      language,
      body: rendered,
      amountPaise: slots.amountPaise,
      includesOffer: template.includes_offer,
    }
  }
}

export function loadTemplates(path = './config/templates.yaml'): TemplateRegistry {
  return new TemplateRegistry(readFileSync(path, 'utf8'))
}
