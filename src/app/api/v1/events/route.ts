import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { getConfig } from '../../../../core/config'
import { signPayload } from '../../../../providers/gateway/adapter'
import { gatewayEventSchema } from '../../../../providers/gateway/webhook-schema'
import { webhookEventId } from '../../../../signal/receiver'
import { runtimeAgent } from '../../../../runtime/instance'
import { consoleDb } from '../../../lib/queries/connection'

export const dynamic = 'force-dynamic'

const SIGNATURE_HEADER = 'x-recoup-signature'
const MAX_BODY_BYTES = 256 * 1024
const EVENT_ID_HEADER = 'x-recoup-event-id'

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env['GATEWAY_WEBHOOK_SECRET']
  if (secret === undefined || secret === '') {
    return NextResponse.json(
      { accepted: false, error: 'GATEWAY_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    )
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { accepted: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    )
  }

  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { accepted: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    )
  }

  const signature = request.headers.get(SIGNATURE_HEADER)

  if (signature === null || !timingSafeMatch(signature, signPayload(raw, secret))) {
    return NextResponse.json(
      { accepted: false, error: 'signature does not match the raw body' },
      { status: 401 },
    )
  }

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(raw)
  } catch {
    return NextResponse.json({ accepted: false, error: 'body is not JSON' }, { status: 400 })
  }

  const event = gatewayEventSchema.safeParse(parsedBody)
  if (!event.success) {
    return NextResponse.json(
      {
        accepted: false,
        error: 'event does not match the expected schema',
        issues: event.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 422 },
    )
  }

  const agent = await runtimeAgent(await consoleDb(), secret)

  let outcome
  try {
    outcome = await agent.ingest({
      eventId: webhookEventId(raw, request.headers.get(EVENT_ID_HEADER)),
      rawBody: raw,
      signature,
    })
  } catch (cause) {
    return NextResponse.json(
      {
        accepted: false,
        error: 'the event was verified but could not be projected into a case',
        detail: cause instanceof Error ? cause.message : 'unknown',
      },
      { status: 500 },
    )
  }

  if (outcome.status === 'DUPLICATE') {
    return NextResponse.json(
      { accepted: true, eventType: event.data.event, status: 'DUPLICATE', casesProjected: 0 },
      { status: 202 },
    )
  }

  if (outcome.status !== 'ACCEPTED') {
    return NextResponse.json(
      { accepted: false, status: outcome.status, error: outcome.reason },
      { status: outcome.status === 'REJECTED' ? 422 : 202 },
    )
  }

  return NextResponse.json(
    {
      accepted: true,
      eventType: event.data.event,
      status: 'ACCEPTED',
      casesProjected: outcome.signals.length,
      dryRun: getConfig().dryRun,
    },
    { status: 202 },
  )
}
