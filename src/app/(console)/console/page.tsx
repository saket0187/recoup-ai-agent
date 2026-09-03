import { formatINR, formatINRCompact, paise } from '../../../core/money'
import { getConfig } from '../../../core/config'
import { excludesZero } from '../../../core/statistics'
import { Sparkline } from '../../components/charts'
import { Odometer } from '../../components/odometer'
import { Term } from '../../components/term'
import { auditSummary, caseList, measurement, consoleState } from '../../lib/console-data'

import { FirstRun } from '../../components/first-run'

export const dynamic = 'force-dynamic'

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function pp(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`
}

export default async function MoneyBoard(): Promise<React.ReactElement> {
  const state = await consoleState()
  if (!state.seeded) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Money board</h1>
            <p className="plain">
              Did chasing these customers actually get us more money than leaving them alone? That
              is the only question this page answers.
            </p>
          </div>
        </div>
        <FirstRun dbPath={state.dbPath} />
      </>
    )
  }

  const [result, cases, audit] = await Promise.all([measurement(), caseList(2000), auditSummary()])
  const seed = getConfig().seed
  const inSample = state.model?.inSample === true

  const fraction = result.incrementalRecoveredFraction
  const significant = excludesZero(fraction)
  const atRisk = cases
    .filter((row) => row.state !== 'RECOVERED' && row.state !== 'WRITTEN_OFF')
    .reduce((sum, row) => sum + row.amountPaise - row.recoveredPaise, 0)

  const recovered = cases.reduce((sum, row) => sum + row.recoveredPaise, 0)
  const billed = cases.reduce((sum, row) => sum + row.amountPaise, 0)

  const funnel = [
    { label: 'Cases opened', value: cases.length },
    { label: 'Diagnosed', value: cases.filter((row) => row.failureClass !== 'UNKNOWN').length },
    { label: 'Contacted', value: cases.filter((row) => row.touchCount > 0).length },
    { label: 'Recovered', value: cases.filter((row) => row.state === 'RECOVERED').length },
  ]
  const funnelTop = Math.max(1, funnel[0]?.value ?? 1)

  const byDay = new Map<number, number>()
  for (const row of cases) {
    if (row.resolvedAt === null) continue
    const day = Math.floor(row.resolvedAt / 86_400_000)
    byDay.set(day, (byDay.get(day) ?? 0) + row.recoveredPaise)
  }
  const series = [...byDay.entries()].sort(([a], [b]) => a - b).map(([, value]) => value / 100)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Money board</h1>
          <p className="plain">
            Did chasing these customers actually get us more money than leaving them alone? That is
            the only question this page answers.
          </p>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <div className="panel-body">
            <div className="headline-label">Extra money recovered because we acted</div>
            <div
              className={`headline-value ${significant ? (fraction.estimate > 0 ? 'pos' : 'neg') : ''}`}
            >
              <Odometer value={pp(fraction.estimate)} />
            </div>
            <div style={{ marginTop: 10 }}>
              <span
                className={`verdict ${significant ? (fraction.estimate > 0 ? 'verdict-good' : 'verdict-bad') : 'verdict-flat'}`}
              >
                {inSample
                  ? 'Measured on the batch the model was trained on'
                  : significant
                    ? fraction.estimate > 0
                      ? 'The agent is beating the old way'
                      : 'The agent is losing to the old way'
                    : 'Too close to call. The agent matches the old way.'}
              </span>
            </div>

            {inSample ? (
              <p className="plain" style={{ marginTop: 10, marginBottom: 0 }}>
                <strong>Read this number with care.</strong> This batch uses seed{' '}
                <span className="num">{seed}</span>, and the loaded model{' '}
                <span className="num">{state.model?.version}</span> was fitted on that same seed. A
                model always looks better on the data it learnt from. The honest figure comes from a
                batch it has never seen: <span className="inline-code">npm run measure</span>, which
                now defaults to a held-out seed and currently reports parity rather than a win.
              </p>
            ) : null}

            <p className="plain" style={{ marginTop: 11, marginBottom: 0 }}>
              We handled 4 in 5 cases with the agent and left 1 in 5 to the{' '}
              <Term name="control">old fixed schedule</Term>. The number above is the difference
              between them, in <Term name="pp">percentage points</Term>. Anywhere between{' '}
              <strong className="num">{pp(fraction.lower)}</strong> and{' '}
              <strong className="num">{pp(fraction.upper)}</strong> is consistent with what we
              observed. That is the <Term name="confidence">95% confidence interval</Term>.
              {significant
                ? ' The range stays on one side of zero, so the effect is real.'
                : ' The range crosses zero, so we cannot claim a real effect yet.'}
            </p>

            <div className="headline-ci">
              {formatINRCompact(paise(Math.round(result.incrementalPerCasePaise.estimate)))} extra
              per case ·{' '}
              {formatINRCompact(paise(Math.round(result.incrementalNetValuePerCasePaise.estimate)))}{' '}
              after what we spent chasing
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Recovered per day</span>
            <span className="panel-hint num">{series.length}d</span>
          </div>
          <div className="panel-body">
            <Sparkline series={series} width={280} height={62} stroke="var(--accent)" />
            <div className="stat-sub" style={{ marginTop: 8 }}>
              {formatINR(paise(recovered))} recovered of {formatINR(paise(billed))} billed
            </div>
          </div>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="stat-label">Still owed</div>
          <div className="stat-value">{formatINRCompact(paise(atRisk))}</div>
          <div className="stat-sub">on cases still open</div>
        </div>
        <div className="stat">
          <div className="stat-label">Paid in full</div>
          <div className="stat-value">
            {pct(result.treatment.recoveryRate.estimate)}
            <span className="dim" style={{ fontSize: 13 }}>
              {' '}
              / {pct(result.control.recoveryRate.estimate)}
            </span>
          </div>
          <div className="stat-sub">agent / old way</div>
        </div>
        <div className="stat">
          <div className="stat-label">Messages per case</div>
          <div className="stat-value">
            {(result.treatment.touches / Math.max(1, result.treatment.cases)).toFixed(2)}
          </div>
          <div className="stat-sub">
            {result.treatment.optOuts} opt-outs · {result.treatment.falseDunningContacts} false
            dunning
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Rules broken</div>
          <div className={`stat-value ${result.policyViolations === 0 ? 'pos' : 'neg'}`}>
            {result.policyViolations}
          </div>
          <div className="stat-sub">messages sent that a rule forbade</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-head">
          <span className="panel-title">Why this number can be trusted, and where it stops</span>
          <span className="panel-hint">the argument, not the assertion</span>
        </div>
        <div className="panel-body">
          <div className="grid cols-2">
            <div>
              <p className="plain" style={{ marginTop: 0 }}>
                <strong>1. There is a real control group.</strong> One case in five is chosen by a
                hash of its id, before anything is known about the outcome, and handled by a fixed
                schedule the agent never touches. Both arms live in the same world, hit the same
                bank outages, and share the same random draws. The gap between them is what is
                reported.
              </p>
              <p className="plain">
                <strong>2. The interval is the claim, not the point.</strong> Every figure is
                bootstrapped over {result.treatment.cases + result.control.cases} cases. If the
                interval crosses zero, we say so instead of rounding it into a win.
              </p>
              <p className="plain" style={{ marginBottom: 0 }}>
                <strong>3. Nothing here is graded by its own author.</strong> Adverse counters sit
                beside the good ones, the audit chain is verifiable, and every decision carries the
                propensity that makes a later re-analysis possible.
              </p>
            </div>
            <div>
              <p className="plain" style={{ marginTop: 0 }}>
                <strong>What this is not.</strong> These customers are synthetic. The constants
                governing how they behave are assumptions we wrote down, so this batch cannot tell
                you what your recovery rate would be. It can tell you the system works end to end,
                that the compliance rules bind, and how the agent compares with a fixed schedule
                under one set of stated assumptions.
              </p>
              <p className="plain" style={{ marginBottom: 0 }}>
                <strong>The part that is checked against real data.</strong> The uplift machinery is
                validated on the Hillstrom email trial, a genuine randomised experiment over 42,694
                customers, where it recovers a known treatment effect. That tests the statistics,
                not the payments domain, and the two claims are kept separate on purpose.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-head">
          <span className="panel-title">What runs before a single message is sent</span>
          <span className="panel-hint num">
            {result.decisionCount.toLocaleString('en-IN')} decisions in this batch
          </span>
        </div>
        <div className="panel-body">
          <div className="grid cols-4">
            {[
              {
                value: '8',
                label: 'Failure classes',
                note: 'The bank error is mapped to one recovery class. Retrying a dead card and retrying a bank blip are different problems.',
              },
              {
                value: '6',
                label: 'Models compared',
                note: 'S-learner and T-learner over logistic regression and boosted trees. One is selected by cross-validated Qini; the rest are recorded so you can see what lost.',
              },
              {
                value: '34',
                label: 'Compliance rules',
                note: 'Quiet hours, consent, do-not-disturb, contact frequency. Ordinary code, not a model. A rule that errors counts as a refusal.',
              },
              {
                value: '18',
                label: 'Stop conditions',
                note: 'Already paid, disputed, bereaved, opted out, budget spent. Evaluated when deciding and again immediately before sending.',
              },
            ].map((entry) => (
              <div key={entry.label}>
                <div className="stat-value" style={{ marginTop: 0 }}>
                  {entry.value}
                </div>
                <div className="stat-label" style={{ marginTop: 3 }}>
                  {entry.label}
                </div>
                <p className="plain" style={{ fontSize: 11.5, marginTop: 5, marginBottom: 0 }}>
                  {entry.note}
                </p>
              </div>
            ))}
          </div>
          <p className="plain" style={{ marginTop: 14, marginBottom: 0 }}>
            On top of those: a bandit that keeps a separate success estimate per action, time slot
            and failure class; an independent reviewer that reads the drafted message and can veto
            it; and a per-cycle budget that ranks admitted actions by value per rupee. A model can
            propose. It can never send or charge.
          </p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Recovery funnel</span>
            <span className="panel-hint">how many cases reach each step</span>
          </div>
          <div className="panel-body">
            {funnel.map((step, index) => (
              <div key={step.label} style={{ marginBottom: 9 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11.5,
                    marginBottom: 3,
                  }}
                >
                  <span className="dim">{step.label}</span>
                  <span className="num">
                    {step.value}{' '}
                    <span className="dim">{((step.value / funnelTop) * 100).toFixed(0)}%</span>
                  </span>
                </div>
                <div
                  style={{
                    height: 13,
                    background: 'var(--surface-2)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    className="bar"
                    style={{
                      width: `${(step.value / funnelTop) * 100}%`,
                      background: index === funnel.length - 1 ? 'var(--ok)' : 'var(--accent-dim)',
                      animationDelay: `${index * 70}ms`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Integrity</span>
            <span className="panel-hint">can you trust the numbers above</span>
          </div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Decisions</dt>
              <dd>{result.decisionCount.toLocaleString('en-IN')}</dd>
              <dt>Propensity coverage</dt>
              <dd className={result.propensityCoverage === 1 ? 'pos' : 'neg'}>
                {pct(result.propensityCoverage)}
              </dd>
              <dt>Audit records</dt>
              <dd>{audit.records.toLocaleString('en-IN')}</dd>
              <dt>Unmapped diagnoses</dt>
              <dd>{pct(result.unmappedRate)}</dd>
              <dt>Dead-lettered</dt>
              <dd className={result.deadLetteredActions === 0 ? '' : 'neg'}>
                {result.deadLetteredActions}
              </dd>
              <dt>Over-contact</dt>
              <dd>{result.treatment.overContactIncidents}</dd>
            </dl>
          </div>
        </div>
      </div>
    </>
  )
}
