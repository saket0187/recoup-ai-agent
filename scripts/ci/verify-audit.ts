import { migrate } from 'drizzle-orm/libsql/migrator'

import { getConfig } from '../../src/core/config'
import { RealClock } from '../../src/core/clock'
import { createIdFactory } from '../../src/core/identifiers'
import { AuditChain, renderChainBreak } from '../../src/db/audit-chain'
import { createDatabase } from '../../src/db/client'

const config = getConfig()
const handle = await createDatabase(config.dbPath)

try {
  await migrate(handle.db, { migrationsFolder: './drizzle' })

  const chain = new AuditChain(handle.db, new RealClock(), createIdFactory('verify'))
  const merchantIds = await chain.listMerchants()

  if (merchantIds.length === 0) {
    console.log('no audit records found')
    process.exit(0)
  }

  let broken = 0
  for (const merchantId of merchantIds) {
    const result = await chain.verify(merchantId)
    console.log(renderChainBreak(result))
    if (!result.intact) broken++
  }

  if (broken > 0) {
    console.error(`${broken} of ${merchantIds.length} chain(s) failed verification`)
    process.exit(1)
  }
} finally {
  handle.close()
}
