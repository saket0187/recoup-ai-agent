import { NextResponse } from 'next/server'

import { getConfig } from '../../../../core/config'
import { TickBusyError } from '../../../../runtime/compose'
import { runtimeAgent } from '../../../../runtime/instance'
import { consoleDb } from '../../../lib/queries/connection'
import { requireApiKey } from '../../auth'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireApiKey(request)
  if (denied !== undefined) return denied

  const secret = process.env['GATEWAY_WEBHOOK_SECRET']
  if (secret === undefined || secret === '') {
    return NextResponse.json(
      { ran: false, error: 'GATEWAY_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    )
  }

  const agent = await runtimeAgent(await consoleDb(), secret)
  const at = agent.clock.now()

  let stats
  try {
    stats = await agent.tick(at)
  } catch (cause) {
    if (cause instanceof TickBusyError) {
      return NextResponse.json({ ran: false, error: cause.message }, { status: 409 })
    }
    throw cause
  }

  return NextResponse.json(
    {
      ran: true,
      at,
      dryRun: getConfig().dryRun,
      decided: stats.cycle.decided,
      scheduled: stats.cycle.scheduled,
      deferred: stats.cycle.deferred,
      suppressed: stats.cycle.suppressed,
      sent: stats.drain.sent,
      repliesRead: stats.inbound.processed,
      promisesBroken: stats.promisesBroken,
      degradedCohorts: stats.incidents.map((health) => health.key),
    },
    { status: 200 },
  )
}
