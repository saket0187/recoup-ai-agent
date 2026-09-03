import { istDateKey, istHour } from '../../../core/calendar'
import { formatINRCompact } from '../../../core/money'
import { CaseTable, type CaseTableRow } from '../../components/case-table'
import { caseCount, caseList, consoleState } from '../../lib/console-data'

const CASE_WINDOW = 2_000

import { FirstRun } from '../../components/first-run'

export const dynamic = 'force-dynamic'

function stamp(at: number): string {
  return `${istDateKey(at)} ${String(istHour(at)).padStart(2, '0')}:00`
}

export default async function Cases(): Promise<React.ReactElement> {
  const state = await consoleState()
  if (!state.seeded) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Cases</h1>
            <p className="plain">One row per customer who owes money.</p>
          </div>
        </div>
        <FirstRun dbPath={state.dbPath} />
      </>
    )
  }

  const [cases, total] = await Promise.all([caseList(CASE_WINDOW), caseCount()])

  const rows: CaseTableRow[] = cases.map((row) => ({
    id: row.id,
    type: row.type,
    state: row.state,
    arm: row.arm,
    failureClass: row.failureClass,
    cohortId: row.cohortId,
    amountLabel: formatINRCompact(row.amountPaise),
    amountPaise: row.amountPaise,
    recoveredLabel: formatINRCompact(row.recoveredPaise),
    recoveredPaise: row.recoveredPaise,
    touchCount: row.touchCount,
    attemptCount: row.attemptCount,
    openedLabel: stamp(row.firstSeenAt),
    firstSeenAt: row.firstSeenAt,
  }))

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Cases</h1>
          <p className="plain">
            One row per customer who owes money. Filter, sort, or search, then open a case to see
            every decision the agent made about it and why.
          </p>
        </div>
      </div>

      <CaseTable rows={rows} total={total} />
    </>
  )
}
