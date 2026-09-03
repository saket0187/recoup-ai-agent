import { istDateKey, istHour } from '../../core/calendar'
import { getConfig } from '../../core/config'
import { NavRail } from '../components/nav-rail'
import { consoleState } from '../lib/console-data'

async function StatusStrip(): Promise<React.ReactElement> {
  const config = getConfig()
  const state = await consoleState().catch(() => undefined)
  const live = !config.dryRun

  const seeded = state?.seeded === true

  return (
    <div className="strip">
      <span className="strip-badge" title="Nothing here is a real customer or a real payment.">
        <span className={`dot ${seeded ? 'dot-ok' : 'dot-idle'}`} />
        <b>Sample batch</b>
        <span>{seeded ? 'synthetic customers, not your data' : 'no batch loaded yet'}</span>
      </span>
      <span className="strip-item">
        <span className={`dot ${live ? 'dot-bad' : 'dot-ok'}`} />
        {live ? 'LIVE: sends are real' : 'DRY RUN'}
      </span>
      <span className="strip-item">
        <span className={`dot ${config.killSwitch ? 'dot-bad' : 'dot-idle'}`} />
        <span className="strip-key">kill</span>
        {config.killSwitch ? 'ENGAGED' : 'off'}
      </span>
      <span className="strip-item">
        <span className="strip-key">clock</span>
        {config.clockMode}
      </span>
      <span className="strip-item">
        <span className="strip-key">seed</span>
        {config.seed}
      </span>
      <span className="strip-item">
        <span className="strip-key">batch</span>
        {state === undefined || !state.seeded
          ? 'none'
          : `${state.cases.toLocaleString('en-IN')} cases · ${istDateKey(state.seededAt ?? 0)} ${String(
              istHour(state.seededAt ?? 0),
            ).padStart(2, '0')}:00`}
      </span>
      <span className="strip-item" style={{ marginLeft: 'auto' }}>
        <span className="strip-key">not a production system</span>
      </span>
    </div>
  )
}

export default function ConsoleLayout({
  children,
}: {
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="shell">
      <NavRail />
      <div className="main">
        <StatusStrip />
        <div className="content">{children}</div>
      </div>
    </div>
  )
}
