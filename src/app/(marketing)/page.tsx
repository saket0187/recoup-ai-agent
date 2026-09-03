import Link from 'next/link'

import { formatINRCompact, paise } from '../../core/money'
import { consoleState } from '../lib/console-data'
import { caseList } from '../lib/queries/cases'

export const dynamic = 'force-dynamic'

const LOOP = [
  { name: 'Detect', note: 'A gateway webhook opens a case and records what is owed.' },
  { name: 'Diagnose', note: 'The bank error maps to one of 8 recovery classes.' },
  { name: 'Decide', note: 'A playbook prices each option against doing nothing.' },
  { name: 'Gate', note: '35 compliance rules, then 18 stop conditions.' },
  { name: 'Execute', note: 'Idempotent outbox; the stop gate runs again first.' },
  { name: 'Measure', note: 'Against a randomised control arm, with intervals.' },
] as const

export default async function Landing(): Promise<React.ReactElement> {
  const state = await consoleState().catch(() => undefined)
  const seeded = state?.seeded === true

  const cases = seeded ? await caseList(4000).catch(() => []) : []
  const recovered = cases.reduce((sum, row) => sum + row.recoveredPaise, 0)
  const distinctTypes = new Set(cases.map((row) => row.type)).size

  return (
    <>
      <main className="lp-main">
        <section className="lp-hero">
          <span className="lp-eyebrow rise" style={{ ['--i' as string]: 0 }}>
            Payment failures · Checkout drop-off · Overdue invoices
          </span>

          <h1 className="lp-title rise" style={{ ['--i' as string]: 1 }}>
            Recoup AI Agent
          </h1>

          <p className="lp-claim rise" style={{ ['--i' as string]: 2 }}>
            Recovers what&rsquo;s recoverable. Stops when it isn&rsquo;t.
          </p>

          <p className="lp-lede rise" style={{ ['--i' as string]: 3 }}>
            An autonomous recovery agent for subscription and invoice businesses. It detects revenue
            at risk, diagnoses the cause from the payment gateway&rsquo;s own error taxonomy, picks
            the cheapest intervention likely to work, and executes it inside hard compliance and
            stopping rules, then measures how much money that actually brought back against a
            randomised control group.
          </p>

          <div className="lp-paths rise" style={{ ['--i' as string]: 4 }}>
            <Link href="/console" className="path path-primary">
              <span className="path-key">Option 01</span>
              <span className="path-title">
                Run it on sample data
                <span className="path-arrow" aria-hidden>
                  &rarr;
                </span>
              </span>
              <p className="path-body">
                Open the operator console against a batch of synthetic customers: 45 days of failed
                payments, replies, and bank outages, with every decision recorded.
              </p>
              <div className="path-meta">
                {seeded
                  ? `${state?.cases.toLocaleString('en-IN')} cases · ${state?.decisions.toLocaleString('en-IN')} decisions ready`
                  : 'no batch yet · npm run seed:console'}
              </div>
            </Link>

            <Link href="/integrate" className="path">
              <span className="path-key">Option 02</span>
              <span className="path-title">
                Connect your own platform
                <span className="path-arrow" aria-hidden>
                  &rarr;
                </span>
              </span>
              <p className="path-body">
                Point your gateway&rsquo;s webhook at one endpoint. Signatures are verified against
                the raw body, payloads are schema-checked, and nothing sends until you turn dry run
                off.
              </p>
              <div className="path-meta">POST /api/v1/events · four steps</div>
            </Link>
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-h">
            {seeded ? 'From the batch loaded right now' : 'Before you start'}
          </h2>

          {seeded ? (
            <div className="proof">
              <div className="proof-cell">
                <div className="proof-value">{state?.cases.toLocaleString('en-IN')}</div>
                <div className="proof-label">Cases opened</div>
              </div>
              <div className="proof-cell">
                <div className="proof-value">{state?.decisions.toLocaleString('en-IN')}</div>
                <div className="proof-label">Decisions recorded</div>
              </div>
              <div className="proof-cell">
                <div className="proof-value">{formatINRCompact(paise(recovered))}</div>
                <div className="proof-label">Recovered</div>
              </div>
              <div className="proof-cell">
                <div className="proof-value">{distinctTypes}</div>
                <div className="proof-label">Loss types covered</div>
              </div>
            </div>
          ) : (
            <div className="honest">
              <p className="honest-head">No batch loaded</p>
              <p>
                The console only ever displays rows that exist, so there is nothing to draw until a
                batch has been generated. One command builds one:
              </p>
              <pre className="code">npm run seed:console</pre>
              <p>
                It takes about a minute and needs no API keys, no database server, and no Python.
              </p>
            </div>
          )}
        </section>

        <section className="lp-section">
          <h2 className="lp-h">What happens to one failed payment</h2>
          <div className="loop">
            {LOOP.map((step, index) => (
              <div className="loop-step" key={step.name} style={{ ['--i' as string]: index }}>
                <div className="loop-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="loop-name">{step.name}</div>
                <p className="loop-note">{step.note}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-h">What we can and cannot claim</h2>
          <div className="honest">
            <p>
              The headline is incremental recovery against a randomised control arm, never gross
              recovered, because most overdue payments arrive eventually whether you chase or not.
              One case in five is held back and handled by a fixed retry-and-reminder schedule so
              the difference can be measured rather than asserted.
            </p>
            <p>
              On the current batch the agent measures at <strong>parity</strong> with that schedule:
              the confidence interval contains zero, so we cannot yet claim it wins. Compliance is
              not in question: policy violations are zero, every decision carries a logged
              propensity, and the audit chain is verifiable with{' '}
              <span className="inline-code">npm run audit:verify</span>, which CI runs on every
              push. Every defect found along the way, including the ones that made earlier and
              better-looking numbers wrong, is written up in{' '}
              <Link href="/help" className="lp-link">
                how it works
              </Link>
              .
            </p>
            <p>
              All data here is simulated. Treat the direction and the ordering as the finding; do
              not quote the rupee figures as though they were observed in the wild.
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <span>deterministic under a seed</span>
        <span>integer paise, never floats</span>
        <span>append-only audit chain</span>
        <span>dry run by default</span>
        <span style={{ marginLeft: 'auto' }}>simulated data, not a production system</span>
      </footer>
    </>
  )
}
