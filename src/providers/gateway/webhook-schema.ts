import { z } from 'zod'

import { ERROR_SOURCES, ERROR_STEPS, PAYMENT_METHODS, PAYMENT_STATUSES } from '../../domain/enums'

export const GATEWAY_EVENT_TYPES = [
  'payment.failed',
  'payment.captured',
  'order.abandoned',
  'payment.authorized',
  'subscription.charged',
  'subscription.halted',
  'subscription.cancelled',
  'invoice.paid',
  'invoice.partially_paid',
  'payment.downtime.started',
  'payment.downtime.resolved',
  'refund.processed',
] as const

export type GatewayEventType = (typeof GATEWAY_EVENT_TYPES)[number]

const paymentEntitySchema = z.object({
  id: z.string(),
  entity: z.literal('payment'),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  order_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  international: z.boolean(),
  method: z.enum(PAYMENT_METHODS),
  amount_refunded: z.number().int().nonnegative(),
  captured: z.boolean(),
  description: z.string().nullable(),
  bank: z.string().nullable(),
  wallet: z.string().nullable(),
  vpa: z.string().nullable(),
  notes: z.record(z.string(), z.string()),
  fee: z.number().int().nullable(),
  tax: z.number().int().nullable(),
  error_code: z.string().nullable(),
  error_description: z.string().nullable(),
  error_source: z.enum(ERROR_SOURCES).nullable(),
  error_step: z.enum(ERROR_STEPS).nullable(),
  error_reason: z.string().nullable(),
  created_at: z.number().int(),
})

const subscriptionEntitySchema = z.object({
  id: z.string(),
  entity: z.literal('subscription'),
  plan_id: z.string(),
  customer_id: z.string(),
  status: z.string(),
  current_start: z.number().int().nullable(),
  current_end: z.number().int().nullable(),
  charge_at: z.number().int().nullable(),
  paid_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative(),
  remaining_count: z.number().int().nonnegative(),
  notes: z.record(z.string(), z.string()),
  created_at: z.number().int(),
})

const invoiceEntitySchema = z.object({
  id: z.string(),
  entity: z.literal('invoice'),
  customer_id: z.string(),
  order_id: z.string().nullable(),
  status: z.string(),
  amount: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative(),
  amount_due: z.number().int(),
  currency: z.string(),
  due_by: z.number().int().nullable(),
  notes: z.record(z.string(), z.string()),
  created_at: z.number().int(),
})

const downtimeEntitySchema = z.object({
  id: z.string(),
  entity: z.literal('payment.downtime'),
  method: z.enum(PAYMENT_METHODS),
  begin: z.number().int(),
  end: z.number().int().nullable(),
  status: z.enum(['started', 'resolved']),
  scheduled: z.boolean(),
  severity: z.enum(['low', 'medium', 'high']),
  instrument: z.object({
    issuer: z.string().nullable(),
    psp: z.string().nullable(),
  }),
  created_at: z.number().int(),
})

const orderEntitySchema = z.object({
  entity: z.literal('order'),
  id: z.string(),
  amount: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative(),
  currency: z.string(),
  status: z.enum(['created', 'attempted', 'paid']),
  attempts: z.number().int().nonnegative(),
  method: z.enum(PAYMENT_METHODS).nullable(),
  customer_id: z.string().nullable(),
  created_at: z.number().int(),
  notes: z.object({
    obligation_id: z.string().optional(),
    customer_ref: z.string().optional(),
  }),
})

export const gatewayEventSchema = z.object({
  entity: z.literal('event'),
  account_id: z.string(),
  event: z.enum(GATEWAY_EVENT_TYPES),
  contains: z.array(z.string()),
  payload: z.object({
    payment: z.object({ entity: paymentEntitySchema }).optional(),
    subscription: z.object({ entity: subscriptionEntitySchema }).optional(),
    invoice: z.object({ entity: invoiceEntitySchema }).optional(),
    order: z.object({ entity: orderEntitySchema }).optional(),
    'payment.downtime': z.object({ entity: downtimeEntitySchema }).optional(),
  }),
  created_at: z.number().int(),
})

export type PaymentEntity = z.infer<typeof paymentEntitySchema>
export type SubscriptionEntity = z.infer<typeof subscriptionEntitySchema>
export type InvoiceEntity = z.infer<typeof invoiceEntitySchema>
export type OrderEntity = z.infer<typeof orderEntitySchema>
export type DowntimeEntity = z.infer<typeof downtimeEntitySchema>
export type GatewayEvent = z.infer<typeof gatewayEventSchema>
