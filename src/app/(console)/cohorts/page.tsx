import { istDateKey, istHour } from '../../../core/calendar'
import { Sparkline } from '../../components/charts'
import { Disclosure } from '../../components/disclosure'
import { cohortHealth, consoleState } from '../../lib/console-data'

import { FirstRun } from '../../components/first-run'

export const dynamic = 'force-dynamic'

function stamp(at: number): string {
  return `${istDateKey(at)} ${String(istHour(at)).padStart(2, '0')}:00`
}

export default async function Cohorts(): Promise<React.ReactElement> {
  const state = await consoleState()
  if (!state.seeded) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Cohort health</h1>
            <p className="plain">Is a bank or payment method having a bad day?</p>
          </div>
        </div>
        <FirstRun dbPath={state.dbPath} />
      </>
    )
  }

  const cells = await cohortHealth()
  const degraded = cells.filter((cell) => cell.state !== 'healthy')
  const incidents = cells
    .filter((cell) => cell.everDegraded)
    .sort((a, b) => b.degradedWindows - a.degradedWindows)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Cohort health</h1>
          <p className="plain">
            Is a bank or payment method having a bad day? One tile per bank-and-method pair. A red
            tile means payments there are failing more than normal, so we pause retries instead of
            burning attempts and annoying customers about a problem that is not theirs.
          </p>
        </div>
        <span className="panel-hint num">
          {degraded.length} degraded now · {incidents.length} degraded at some point ·{' '}
          {cells.length} tracked
        </span>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 12 }}>
        {cells.map((cell, index) => (
          <div className="cell" data-state={cell.state} key={cell.cohortId}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="num" style={{ fontSize: 12 }}>
                {cell.method}
                <span className="dim"> · {cell.issuer}</span>
              </span>
              <span
                className={`dot ${
                  cell.state === 'degraded'
                    ? 'dot-bad'
                    : cell.state === 'paused'
                      ? 'dot-warn'
                      : 'dot-ok'
                }`}
              />
            </div>

            <div style={{ margin: '5px 0 3px' }}>
              <Sparkline
                series={cell.series}
                width={168}
                height={26}
                index={index}
                stroke={
                  cell.state === 'degraded'
                    ? 'var(--bad)'
                    : cell.state === 'paused'
                      ? 'var(--warn)'
                      : 'var(--info)'
                }
              />
            </div>

            <div className="num" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              lcb {(cell.wilsonLcb * 100).toFixed(1)}% · base {(cell.baseline * 100).toFixed(1)}%
            </div>
            <div className="num" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              {cell.attempts} attempts · {cell.cases} cases · {cell.recovered} recovered
            </div>
          </div>
        ))}
      </div>

      {cells.length === 0 ? (
        <div className="panel">
          <div className="empty">No cohort windows recorded. Run npm run seed:console.</div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Incidents</span>
          <span className="panel-hint">
            every cohort that was degraded in any window, not only right now
          </span>
        </div>
        <div className="panel-body">
          {incidents.length === 0 ? (
            <div className="empty">No cohort was ever flagged degraded in this batch.</div>
          ) : (
            incidents.map((cell) => (
              <div
                key={cell.cohortId}
                style={{
                  borderBottom: '1px solid var(--line)',
                  paddingBottom: 6,
                  marginBottom: 6,
                }}
              >
                <Disclosure
                  summary={
                    <div
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'baseline',
                        padding: '3px 0',
                      }}
                    >
                      <span className="caret">›</span>
                      <span className={`tag ${cell.state === 'degraded' ? 'tag-bad' : 'tag-warn'}`}>
                        {cell.degradedWindows} degraded{' '}
                        {cell.degradedWindows === 1 ? 'window' : 'windows'}
                      </span>
                      <span className="num">{cell.cohortId}</span>
                      <span className="dim num" style={{ marginLeft: 'auto', fontSize: 11 }}>
                        onset {stamp(cell.since)} · now {cell.state}
                      </span>
                    </div>
                  }
                >
                  <div className="stagger" style={{ paddingTop: 8 }}>
                    <dl className="kv" style={{ ['--i' as string]: 0 }}>
                      <dt>Wilson LCB now</dt>
                      <dd>{(cell.wilsonLcb * 100).toFixed(2)}%</dd>
                      <dt>Worst Wilson LCB</dt>
                      <dd className="neg">{(cell.worstLcb * 100).toFixed(2)}%</dd>
                      <dt>Learned baseline</dt>
                      <dd>{(cell.baseline * 100).toFixed(2)}%</dd>
                      <dt>Attempts observed</dt>
                      <dd>{cell.attempts}</dd>
                      <dt>Failure rate</dt>
                      <dd className="neg">{(cell.failureRate * 100).toFixed(1)}%</dd>
                      <dt>Cases opened</dt>
                      <dd>{cell.cases}</dd>
                      <dt>Recovered</dt>
                      <dd>{cell.recovered}</dd>
                    </dl>
                    <p
                      className="panel-hint"
                      style={{ ['--i' as string]: 1, marginTop: 8, marginBottom: 0 }}
                    >
                      While a cohort is paused the playbook stops proposing retries into it, and the
                      engine raises an operational action rather than contacting customers about a
                      failure that is ours.
                    </p>
                  </div>
                </Disclosure>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
