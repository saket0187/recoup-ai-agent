import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

const API_KEY_HEADER = 'x-recoup-api-key'

export function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function requireApiKey(request: Request): NextResponse | undefined {
  const expected = process.env['RECOUP_API_KEY']
  if (expected === undefined || expected === '') {
    return NextResponse.json(
      {
        error: 'RECOUP_API_KEY is not configured',
        detail:
          'This endpoint returns the whole book of business and refuses to serve it unguarded',
      },
      { status: 503 },
    )
  }

  const provided = request.headers.get(API_KEY_HEADER)
  if (provided === null || !timingSafeMatch(provided, expected)) {
    return NextResponse.json({ error: 'api key is missing or does not match' }, { status: 401 })
  }

  return undefined
}
