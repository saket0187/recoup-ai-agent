import Link from 'next/link'

export const dynamic = 'force-static'

const STEPS = [
  {
    title: 'Point your gateway at one endpoint',
    body: 'Every event arrives through a single route. The signature is checked against the raw request body before anything is parsed, using a constant-time comparison, and the payload is then validated against a schema. An accepted event is verified, persisted, and projected into a case in the same request, so a 202 means the case exists.',
    code: `POST https://your-host/api/v1/events
x-recoup-signature: <hmac-sha256 of the raw body>`,
  },
  {
    title: 'Set the shared secret',
    body: 'Without it the endpoint refuses everything with a 503 rather than accepting unsigned traffic. That is deliberate: an integration that half-works is worse than one that does not start.',
    code: `# .env
GATEWAY_WEBHOOK_SECRET=your_webhook_secret`,
  },
  {
    title: 'Map your gateway to the shared vocabulary',
    body: 'The engine never learns any one gateway’s wording. It speaks in normalised terms, and each provider’s specifics live behind a port. There are two adapters in the repository with different envelopes and different signature schemes, and a test asserts that the second one reaches the same engine without changing a line of it.',
    code: `src/providers/gateway/adapter.ts    # hex HMAC header, nested payload envelope
src/providers/cardnet/adapter.ts    # t=,v1= signature, flat data.object envelope
src/providers/port.ts               # the interface both implement`,
  },
  {
    title: 'Tune the limits to your business',
    body: 'Anything with a threshold, cap, or rate is configuration rather than code, so changing policy does not mean changing the engine.',
    code: `config/policy.yaml      # 35 compliance rules: quiet hours, consent, frequency
config/authority.yaml   # touch and retry caps, discount ceilings, cycle budgets
config/costs.yaml       # channel and action costs, margin rate
config/templates.yaml   # message templates in English, Hindi, Hinglish
config/calendar.yaml    # bank holidays and festival windows`,
  },
] as const

const RESPONSES = [
  ['202', 'Verified, stored, and projected into a case'],
  ['401', 'Signature does not match the raw body'],
  ['413', 'Body over 256KB'],
  ['422', 'Schema mismatch, with the exact fields listed'],
  ['503', 'GATEWAY_WEBHOOK_SECRET is not configured'],
] as const

export default function Integrate(): React.ReactElement {
  return (
    <>
      <main className="lp-main">
        <section className="lp-hero">
          <span className="lp-eyebrow rise" style={{ ['--i' as string]: 0 }}>
            Integration
          </span>
          <h1
            className="lp-title rise"
            style={{ ['--i' as string]: 1, fontSize: 'clamp(28px,4vw,42px)' }}
          >
            Connect your own platform
          </h1>
          <p className="lp-lede rise" style={{ ['--i' as string]: 2 }}>
            Four steps. Nothing sends or charges until you explicitly turn dry run off, and going
            live needs two independent signals, so you can run the whole thing against production
            traffic in observation mode first.
          </p>
        </section>

        <section className="lp-section">
          <h2 className="lp-h">Steps</h2>
          {STEPS.map((step, index) => (
            <div className="step-row" key={step.title}>
              <span className="step-num">{String(index + 1).padStart(2, '0')}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
                  {step.title}
                </div>
                <p className="lp-lede" style={{ marginTop: 6, fontSize: 12.5 }}>
                  {step.body}
                </p>
                <pre className="code">{step.code}</pre>
              </div>
            </div>
          ))}
        </section>

        <section className="lp-section">
          <h2 className="lp-h">What the endpoint answers</h2>
          <div className="panel" style={{ maxWidth: 640 }}>
            <table>
              <caption className="table-caption">
                Every outcome is a distinct status code, so a misconfigured integration is never
                mistaken for an accepted one.
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 70 }}>
                    Code
                  </th>
                  <th scope="col">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {RESPONSES.map(([code, meaning]) => (
                  <tr key={code}>
                    <td
                      className="num"
                      style={{ color: code === '202' ? 'var(--ok)' : 'var(--bad)' }}
                    >
                      {code}
                    </td>
                    <td>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-h">Driving the loop</h2>
          <div className="honest">
            <p>
              Receiving an event opens a case. Deciding what to do about it happens on a tick, which
              you drive from your own scheduler so nothing runs on a timer you cannot see:
            </p>
            <pre className="code">{`POST /api/v1/tick
x-recoup-api-key: <RECOUP_API_KEY>`}</pre>
            <p>
              One tick runs the whole cycle: cohort health, inbound replies, expiring promises,
              feedback settlement, the decision cycle, and the outbox drain. It answers with what it
              did. Call it every few minutes.
            </p>
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-h">Reading results back out</h2>
          <div className="honest">
            <p>
              <span className="inline-code">GET /api/v1/metrics</span> returns the same figures the
              console shows: incremental recovery with its interval, both arms, the harm counters,
              and the integrity counters, as JSON for polling from a monitoring system. It needs the
              same <span className="inline-code">RECOUP_API_KEY</span> header, and refuses to serve
              anything at all until that key is set.
            </p>
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-h">Before going live</h2>
          <div className="honest">
            <p>
              <span className="inline-code">DRY_RUN</span> defaults to true. Every decision is made,
              gated, and recorded; nothing leaves the process. Turning it off needs both of these,
              and either one alone is rejected at startup:
            </p>
            <pre className="code">{`DRY_RUN=false
LIVE_CONFIRM=I_UNDERSTAND`}</pre>
            <p>
              There is also a global kill switch that halts execution and drains the outbox without
              losing queued work.
            </p>
          </div>
        </section>

        <section className="lp-section">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Link href="/console" className="path path-primary" style={{ flex: '1 1 260px' }}>
              <span className="path-key">Before you wire anything up</span>
              <span className="path-title">
                Run it on sample data
                <span className="path-arrow" aria-hidden>
                  &rarr;
                </span>
              </span>
              <p className="path-body">
                The same screens your own traffic would populate, on a synthetic batch.
              </p>
            </Link>
            <Link href="/help" className="path" style={{ flex: '1 1 260px' }}>
              <span className="path-key">Background</span>
              <span className="path-title">
                How the decision loop works
                <span className="path-arrow" aria-hidden>
                  &rarr;
                </span>
              </span>
              <p className="path-body">
                Eight steps from a failed payment to a measured result, plus a glossary.
              </p>
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <Link href="/" className="lp-link">
          Back to the overview
        </Link>
        <span style={{ marginLeft: 'auto' }}>simulated data, not a production system</span>
      </footer>
    </>
  )
}
