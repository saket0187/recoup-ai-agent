import { migrate } from 'drizzle-orm/libsql/migrator'

import { getConfig } from '../../src/core/config'
import { createDatabase } from '../../src/db/client'

const config = getConfig()
const handle = await createDatabase(config.dbPath)

try {
  await migrate(handle.db, { migrationsFolder: './drizzle' })
  console.log(`migrations applied to ${config.dbPath}`)
} finally {
  handle.close()
}
