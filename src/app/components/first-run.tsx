const STEPS = [
  {
    command: 'npm run seed:console',
    label: 'Generate a batch and run the agent over it',
    detail:
      'Simulates 45 days of a subscription business, with payments failing, customers replying and a couple of bank outages, then runs the full decision loop against it. Takes about a minute.',
  },
  {
    command: 'npm run dev',
    label: 'Reload this page',
    detail: 'Every screen reads the database that the previous step leaves behind.',
  },
] as const

export function FirstRun({ dbPath }: { readonly dbPath: string }): React.ReactElement {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Nothing to show yet</span>
        <span className="panel-hint num">{dbPath}</span>
      </div>
      <div className="panel-body">
        <p className="plain" style={{ marginTop: 0 }}>
          The database is set up but empty. This console only ever displays real rows, so there is
          nothing to draw until a batch has been run. Two commands:
        </p>

        {STEPS.map((step, index) => (
          <div key={step.command} style={{ display: 'flex', gap: 12, marginTop: 14 }}>
            <span className="num" style={{ color: 'var(--accent)', minWidth: 14 }}>
              {index + 1}
            </span>
            <div style={{ minWidth: 0 }}>
              <code
                className="num"
                style={{
                  display: 'inline-block',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  padding: '3px 8px',
                  fontSize: 12,
                }}
              >
                {step.command}
              </code>
              <div style={{ fontSize: 12.5, marginTop: 5 }}>{step.label}</div>
              <p className="plain" style={{ margin: '3px 0 0', color: 'var(--text-faint)' }}>
                {step.detail}
              </p>
            </div>
          </div>
        ))}

        <p className="plain" style={{ marginTop: 18, marginBottom: 0 }}>
          No API keys, no database server, and no Python are needed for any of this.
        </p>
      </div>
    </div>
  )
}
