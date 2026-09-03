'use client'

export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string }
  readonly reset: () => void
}): React.ReactElement {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">This screen could not be rendered</span>
        {error.digest === undefined ? null : <span className="panel-hint num">{error.digest}</span>}
      </div>
      <div className="panel-body">
        <p className="plain" style={{ marginTop: 0 }}>
          The console reads directly from the database a batch leaves behind. The usual cause is
          that no batch has been run yet, or that the schema is older than the code.
        </p>

        <pre
          className="num"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: 10,
            fontSize: 11.5,
            overflowX: 'auto',
            color: 'var(--bad)',
          }}
        >
          {error.message}
        </pre>

        <p className="plain">
          Try <code className="num">npm run db:migrate</code> then{' '}
          <code className="num">npm run seed:console</code>.
        </p>

        <button type="button" className="chip" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  )
}
