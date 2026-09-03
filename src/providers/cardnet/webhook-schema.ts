import { z } from 'zod'

const instrumentSchema = z.object({
  kind: z.enum(['card', 'bank_debit', 'vpa', 'wallet']),
  issuer: z.string().min(1).nullable(),
})

const declineSchema = z.object({
  code: z.string().min(1),
  origin: z.enum(['issuer', 'network', 'processor', 'merchant']),
  phase: z.enum(['authorization', 'authentication', 'capture', 'mandate']),
  description: z.string().min(1),
})

const objectSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1).nullable(),
  customer_ref: z.string().min(1).nullable(),
  amount_minor: z.number().int().nonnegative(),
  amount_settled_minor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3),
  instrument: instrumentSchema.nullable(),
  decline: declineSchema.nullable(),
})

export const cardnetEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'charge.declined',
    'charge.succeeded',
    'checkout.session.expired',
    'invoice.settled',
    'invoice.part_settled',
    'mandate.revoked',
  ]),
  occurred_at: z.string().min(1),
  livemode: z.boolean(),
  data: z.object({ object: objectSchema }),
})

export type CardnetEvent = z.infer<typeof cardnetEventSchema>
