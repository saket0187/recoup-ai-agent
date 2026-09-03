import Link from 'next/link'

import { istDateKey, istHour } from '../../../core/calendar'
import { formatINRCompact } from '../../../core/money'
import { DisclosureRow } from '../../components/disclosure'
import { exceptions, consoleState } from '../../lib/console-data'

import { FirstRun } from '../../components/first-run'

export const dynamic = 'force-dynamic'

const KIND_TAG: Readonly<Record<string, string>> = {
  ESCALATION: 'tag-warn',
  STOPPED: 'tag-bad',
  DEAD_LETTER: 'tag-bad',
}

const WHY: Readonly<Record<string, string>> = {
  ESCALATION:
    'The action needed authority beyond the bounds set in config/authority.yaml. Bounded authority is enforced in code, never by a model, and anything past the bound routes to a human instead of being attempted.',
  STOPPED:
    'A stop condition fired. The stop gate runs twice, once at decision time and again immediately before execution, because state changes in between and that is a real bug class.',
  DEAD_LETTER:
    'The outbox exhausted its bounded retry budget for this action. It is parked rather than retried forever, and nothing is silently dropped.',
}

function stamp(at: number): string {
  return `${istDateKey(at)} ${String(istHour(at)).padStart(2, '0')}:00`
}

export default async function Exceptions(): Promise<React.ReactElement> {
  const state = await consoleState()
  if (!state.seeded) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Approvals and exceptions</h1>
            <p className="plain">Everything the agent would not do on its own.</p>
          </div>
        </div>
        <FirstRun dbPath={state.dbPath} />
      </>
    )
  }

  const rows = await exceptions(200)
  const counts = {
    ESCALATION: rows.filter((row) => row.kind === 'ESCALATION').length,
    STOPPED: rows.filter((row) => row.kind === 'STOPPED').length,
    DEAD_LETTER: rows.filter((row) => row.kind === 'DEAD_LETTER').length,
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Approvals and exceptions</h1>
          <p className="page-note">
            Everything the agent refused to do on its own authority, with the reason it routed here.
            Expand a row for the rule that put it there.
          </p>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="stat-label">Needs a person</div>
          <div className="stat-value">{counts.ESCALATION}</div>
          <div className="stat-sub">beyond what the agent may decide alone</div>
        </div>
        <div className="stat">
          <div className="stat-label">Stopped on purpose</div>
          <div className="stat-value">{counts.STOPPED}</div>
          <div className="stat-sub">chasing further would be wrong or pointless</div>
        </div>
        <div className="stat">
          <div className="stat-label">Dead-lettered</div>
          <div className={`stat-value ${counts.DEAD_LETTER > 0 ? 'neg' : ''}`}>
            {counts.DEAD_LETTER}
          </div>
          <div className="stat-sub">gave up after repeated delivery failures</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Queue</span>
          <span className="panel-hint num">{rows.length} items</span>
        </div>

        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Case</th>
                <th>Action</th>
                <th>Reason</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <DisclosureRow
                  key={`${row.caseId}-${row.at}-${index}`}
                  columns={6}
                  cells={[
                    <span className="num dim" style={{ fontSize: 11 }}>
                      {stamp(row.at)}
                    </span>,
                    <span className={`tag ${KIND_TAG[row.kind] ?? ''}`}>{row.kind}</span>,
                    <span className="num">{row.caseId}</span>,
                    <span className="num">{row.action}</span>,
                    <span className="num">{row.reason}</span>,
                    <span className="num" style={{ display: 'block', textAlign: 'right' }}>
                      {formatINRCompact(row.amountPaise)}
                    </span>,
                  ]}
                >
                  <div className="stagger">
                    <p
                      style={{
                        ['--i' as string]: 0,
                        margin: '0 0 8px',
                        fontSize: 12,
                        maxWidth: '80ch',
                      }}
                    >
                      {WHY[row.kind]}
                    </p>
                    <dl className="kv" style={{ ['--i' as string]: 1 }}>
                      <dt>Detail</dt>
                      <dd>{row.detail}</dd>
                      <dt>Case</dt>
                      <dd>
                        <Link href={`/cases/${row.caseId}`} style={{ color: 'var(--accent)' }}>
                          open the full timeline →
                        </Link>
                      </dd>
                    </dl>
                  </div>
                </DisclosureRow>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            Nothing routed to a human, stopped, or dead-lettered in this batch.
          </div>
        ) : null}
      </div>
    </>
  )
}
