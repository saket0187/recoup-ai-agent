import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'

import { schema } from './schema'

export type Database = LibSQLDatabase<typeof schema>

export interface DatabaseHandle {
  readonly db: Database
  readonly client: Client
  close(): void
}

const IN_MEMORY = ':memory:'

function toUrl(dbPath: string): string {
  if (dbPath === IN_MEMORY || dbPath.startsWith('file:')) return dbPath
  mkdirSync(dirname(dbPath), { recursive: true })
  return `file:${dbPath}`
}

export async function createDatabase(dbPath: string): Promise<DatabaseHandle> {
  const client = createClient({ url: toUrl(dbPath) })

  await client.execute('PRAGMA foreign_keys = ON')
  if (dbPath !== IN_MEMORY) {
    await client.execute('PRAGMA journal_mode = WAL')
  }
  await client.execute('PRAGMA busy_timeout = 5000')

  const db = drizzle(client, { schema })

  return {
    db,
    client,
    close: () => client.close(),
  }
}
