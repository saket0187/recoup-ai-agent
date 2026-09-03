import { rmSync } from 'node:fs'

import { migrate } from 'drizzle-orm/libsql/migrator'

import { getConfig } from '../../src/core/config'
import { createDatabase } from '../../src/db/client'

const config = getConfig()

if (config.dbPath === ':memory:') {
  throw new Error('db:reset expects a file-backed DB_PATH')
}

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(`${config.dbPath}${suffix}`, { force: true })
}

const handle = await createDatabase(config.dbPath)

try {
  await migrate(handle.db, { migrationsFolder: './drizzle' })
  console.log(`reset and migrated ${config.dbPath}`)
} finally {
  handle.close()
}
