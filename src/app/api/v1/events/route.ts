import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { getConfig } from '../../../../core/config'
import { signPayload } from '../../../../providers/gateway/adapter'
import { webhookEventId } from '../../../../signal/receiver'
import { runtimeAgent } from '../../../../runtime/instance'
import { consoleDb } from '../../../lib/queries/connection'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 256 * 1024

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function eventTypeOf(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'event' in parsed) {
      return typeof parsed.event === 'string' ? parsed.event : 'unknown'
    }
    return 'unknown'
  } catch {
    return 'unparseable'
  }
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

  const config = getConfig()
  const signature = request.headers.get(config.webhookSignatureHeader)

  if (signature === null || !timingSafeMatch(signature, signPayload(raw, secret))) {
    return NextResponse.json(
      { accepted: false, error: 'signature does not match the raw body' },
      { status: 401 },
    )
  }

  const eventType = eventTypeOf(raw)
  const agent = await runtimeAgent(await consoleDb(), secret)

  let outcome
  try {
    outcome = await agent.ingest({
      eventId: webhookEventId(raw, request.headers.get(config.webhookEventIdHeader)),
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
      { accepted: true, eventType, status: 'DUPLICATE', casesProjected: 0 },
      { status: 202 },
    )
  }

  if (outcome.status !== 'ACCEPTED') {
    return NextResponse.json(
      { accepted: false, eventType, status: outcome.status, error: outcome.reason },
      { status: outcome.status === 'REJECTED' ? 401 : 202 },
    )
  }

  return NextResponse.json(
    {
      accepted: true,
      eventType,
      status: 'ACCEPTED',
      casesProjected: outcome.signals.length,
      dryRun: config.dryRun,
    },
    { status: 202 },
  )
}
