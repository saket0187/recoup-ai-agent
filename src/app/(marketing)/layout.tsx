import Link from 'next/link'

export default function MarketingLayout({
  children,
}: {
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="lp">
      <header className="lp-bar">
        <Link href="/" className="lp-mark">
          <span className="lp-mark-name">Recoup AI Agent</span>
          <span className="lp-mark-sub">bounded revenue recovery</span>
        </Link>

        <nav
          style={{ marginLeft: 'auto', display: 'flex', gap: 18, alignItems: 'center' }}
          aria-label="Primary"
        >
          <Link href="/integrate" className="lp-bar-link">
            Integrate
          </Link>
          <Link href="/help" className="lp-bar-link">
            How it works
          </Link>
          <Link href="/console" className="lp-bar-link" style={{ color: 'var(--accent)' }}>
            See it running
          </Link>
        </nav>
      </header>

      {children}
    </div>
  )
}
