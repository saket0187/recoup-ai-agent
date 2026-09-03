import { readFileSync } from 'node:fs'

import { excludesZero } from '../../../core/statistics'
import { parseUpliftModel } from '../../../uplift/model'
import { DivergingBar, QiniCurve } from '../../components/charts'
import { Disclosure } from '../../components/disclosure'
import { measurement, consoleState } from '../../lib/console-data'

import { FirstRun } from '../../components/first-run'

export const dynamic = 'force-dynamic'

function loadModel(): ReturnType<typeof parseUpliftModel> | undefined {
  try {
    return parseUpliftModel(JSON.parse(readFileSync('./fixtures/uplift-model.json', 'utf8')))
  } catch {
    return undefined
  }
}

function pp(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`
}

function qiniPoints(cvQini: number): { x: number; y: number }[] {
  const steps = 40
  return Array.from({ length: steps + 1 }, (_, index) => {
    const x = index / steps
    return { x, y: x + cvQini * 4 * x * (1 - x) }
  })
}

export default async function BatchResults(): Promise<React.ReactElement> {
  const state = await consoleState()
  if (!state.seeded) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Batch results</h1>
            <p className="plain">
              The full comparison between the agent and the old fixed schedule.
            </p>
          </div>
        </div>
        <FirstRun dbPath={state.dbPath} />
      </>
    )
  }

  const result = await measurement()
  const model = loadModel()

  const rows = [
    {
      label: 'Incremental recovered fraction',
      interval: result.incrementalRecoveredFraction,
      format: pp,
    },
  ]

  const candidates = model?.provenance.candidates ?? []
  const bestQini = Math.max(...candidates.map((entry) => Math.abs(entry.cvQini)), 0.01)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Batch results</h1>
          <p className="plain">
            The full comparison between the agent and the old fixed schedule, the models we tried,
            and the harm we caused along the way. The bad numbers sit next to the good ones on
            purpose.
          </p>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 12 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Treatment vs control</span>
            <span className="panel-hint num">
              {result.treatment.cases} / {result.control.cases} cases
            </span>
          </div>
          <div className="panel-body">
            {rows.map((row) => (
              <div key={row.label}>
                <div className="stat-label">{row.label}</div>
                <div
                  className={`stat-value ${excludesZero(row.interval) ? (row.interval.estimate > 0 ? 'pos' : 'neg') : ''}`}
                >
                  {row.format(row.interval.estimate)}
                </div>
                <div className="stat-sub">
                  [{row.format(row.interval.lower)}, {row.format(row.interval.upper)}]{' '}
                  {excludesZero(row.interval) ? 'significant' : 'contains zero'}
                </div>
              </div>
            ))}

            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Arm</th>
                  <th className="right">Cases</th>
                  <th className="right">Recovery</th>
                  <th className="right">Touches/case</th>
                  <th className="right">Opt-outs</th>
                </tr>
              </thead>
              <tbody>
                {[result.treatment, result.control].map((arm) => (
                  <tr key={arm.arm}>
                    <td>
                      <span className={`tag ${arm.arm === 'TREATMENT' ? 'tag-accent' : ''}`}>
                        {arm.arm}
                      </span>
                    </td>
                    <td className="right num">{arm.cases}</td>
                    <td className="right num">{(arm.recoveryRate.estimate * 100).toFixed(1)}%</td>
                    <td className="right num">
                      {(arm.touches / Math.max(1, arm.cases)).toFixed(2)}
                    </td>
                    <td className="right num">{arm.optOuts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Uplift model</span>
            <span className="panel-hint num">{model?.version ?? 'not loaded'}</span>
          </div>
          <div className="panel-body">
            {model === undefined ? (
              <div className="empty">No model committed. Run npm run train:uplift.</div>
            ) : (
              <>
                <QiniCurve points={qiniPoints(model.metrics.cvQini)} />
                <div className="stat-sub" style={{ marginBottom: 10 }}>
                  Qini {model.metrics.cvQini.toFixed(4)} ± {model.metrics.cvQiniStdError.toFixed(4)}{' '}
                  · out-of-fold Brier {model.metrics.outOfFoldBrier.toFixed(4)} ·{' '}
                  {model.metrics.rows.toLocaleString('en-IN')} rows
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Learner</th>
                      <th className="right">CV Qini</th>
                      <th style={{ width: 120 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((entry, index) => (
                      <tr key={entry.learner}>
                        <td className="num">
                          {entry.selected ? (
                            <span className="tag tag-accent">{entry.learner}</span>
                          ) : (
                            <span className="dim">{entry.learner}</span>
                          )}
                        </td>
                        <td className="right num">
                          {entry.cvQini.toFixed(4)}
                          <span className="dim"> ± {entry.cvQiniStdError.toFixed(4)}</span>
                        </td>
                        <td>
                          <DivergingBar value={entry.cvQini} domain={bestQini} index={index} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="panel-hint" style={{ marginTop: 10 }}>
                  Selection is the one-standard-error rule: the simplest candidate within one
                  standard error of the best, because cross-validated Qini is itself an estimate.
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-head">
          <span className="panel-title">Harm we caused</span>
        </div>
        <div className="panel-body">
          <div className="grid cols-4">
            {[
              { label: 'Opt-outs', value: result.treatment.optOuts, bad: false },
              {
                label: 'False dunning',
                value: result.treatment.falseDunningContacts,
                bad: result.treatment.falseDunningContacts > 0,
              },
              {
                label: 'Over-contact',
                value: result.treatment.overContactIncidents,
                bad: result.treatment.overContactIncidents > 0,
              },
              {
                label: 'Policy violations',
                value: result.policyViolations,
                bad: result.policyViolations > 0,
              },
            ].map((entry) => (
              <div key={entry.label}>
                <div className="stat-label">{entry.label}</div>
                <div className={`stat-value ${entry.bad ? 'neg' : ''}`}>{entry.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">How to read this</span>
        </div>
        <div className="panel-body">
          <Disclosure
            summary={
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0' }}>
                <span className="caret">›</span>
                <span style={{ fontSize: 12.5 }}>
                  Why the headline is incremental, and what it excludes
                </span>
              </div>
            }
          >
            <div className="stagger" style={{ paddingTop: 8, fontSize: 12, maxWidth: '78ch' }}>
              <p style={{ ['--i' as string]: 0, marginTop: 0 }}>
                Gross recovered is the number people ask for and it is nearly meaningless here: most
                of it would have arrived anyway. The control arm exists so the difference can be
                measured rather than asserted.
              </p>
              <p style={{ ['--i' as string]: 1 }}>
                Absolute rupees per case has variance dominated by how much invoice sizes differ
                rather than by the treatment. The recovered <em>fraction</em> removes that and is
                the more sensitive test.
              </p>
              <p style={{ ['--i' as string]: 2 }}>
                Churn avoided is not reported. The simulator models cancellation but the engine
                never observes it, so attributing it would mean reading latent state.
              </p>
              <p style={{ ['--i' as string]: 3, marginBottom: 0 }}>
                Every figure comes from a simulated world whose constants are documented
                assumptions. Treat the sign and the ordering as the claim.
              </p>
            </div>
          </Disclosure>
        </div>
      </div>
    </>
  )
}
