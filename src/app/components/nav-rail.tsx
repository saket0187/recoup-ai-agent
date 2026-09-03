'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const SCREENS = [
  { href: '/console', index: '01', label: 'Money board' },
  { href: '/batch', index: '02', label: 'Batch results' },
  { href: '/cases', index: '03', label: 'Cases' },
  { href: '/cohorts', index: '04', label: 'Cohort health' },
  { href: '/exceptions', index: '05', label: 'Exceptions' },
] as const

export function NavRail(): React.ReactElement {
  const pathname = usePathname()

  const isActive = (href: string): boolean =>
    href === '/console' ? pathname === '/console' : pathname.startsWith(href)

  return (
    <nav className="rail">
      <Link href="/" className="brand">
        <div className="brand-name">Recoup AI Agent</div>
        <div className="brand-sub">operator console · back to overview</div>
      </Link>

      <div className="nav">
        {SCREENS.map((screen) => (
          <Link
            key={screen.href}
            href={screen.href}
            className="nav-item"
            data-active={isActive(screen.href)}
          >
            <span className="nav-index">{screen.index}</span>
            {screen.label}
          </Link>
        ))}
      </div>

      <div className="rail-foot">
        <span>append-only audit</span>
        <span>integer paise</span>
        <span>seeded · replayable</span>
      </div>
    </nav>
  )
}
