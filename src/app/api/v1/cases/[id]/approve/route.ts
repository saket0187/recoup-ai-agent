import { NextResponse } from 'next/server'
import { z } from 'zod'

import { runtimeAgent } from '../../../../../../runtime/instance'
import { consoleDb } from '../../../../../lib/queries/connection'
import { requireApiKey } from '../../../../auth'

export const dynamic = 'force-dynamic'

const approvalSchema = z.object({ approvedBy: z.string().trim().min(1).max(80) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = requireApiKey(request)
  if (denied !== undefined) return denied

  const secret = process.env['GATEWAY_WEBHOOK_SECRET']
  if (secret === undefined || secret === '') {
    return NextResponse.json(
      { approved: false, error: 'GATEWAY_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    )
  }

  const body = approvalSchema.safeParse(await request.json().catch(() => undefined))
  if (!body.success) {
    return NextResponse.json(
      { approved: false, error: 'send {"approvedBy": "<who is approving>"}' },
      { status: 400 },
    )
  }

  const { id } = await params
  const agent = await runtimeAgent(await consoleDb(), secret)
  const outcome = await agent.approve(id, body.data.approvedBy)

  if (outcome === 'NOT_FOUND') {
    return NextResponse.json({ approved: false, error: `no case ${id}` }, { status: 404 })
  }

  return NextResponse.json({ approved: true, caseId: id, status: outcome }, { status: 200 })
}
