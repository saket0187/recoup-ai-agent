'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

export interface CaseTableRow {
  readonly id: string
  readonly type: string
  readonly state: string
  readonly arm: string
  readonly failureClass: string
  readonly cohortId: string | null
  readonly amountLabel: string
  readonly amountPaise: number
  readonly recoveredLabel: string
  readonly recoveredPaise: number
  readonly touchCount: number
  readonly attemptCount: number
  readonly openedLabel: string
  readonly firstSeenAt: number
}

const STATE_TONE: Readonly<Record<string, string>> = {
  RECOVERED: 'tag-ok',
  STOPPED: 'tag-bad',
  WRITTEN_OFF: 'tag-bad',
  AWAITING_HUMAN: 'tag-warn',
  PAUSED_DOWNTIME: 'tag-warn',
}

type SortKey = 'amountPaise' | 'recoveredPaise' | 'touchCount' | 'firstSeenAt'

const COLUMNS: readonly { key: SortKey; label: string; hint: string }[] = [
  { key: 'amountPaise', label: 'Owed', hint: 'what the customer was billed' },
  { key: 'recoveredPaise', label: 'Got back', hint: 'how much has been recovered' },
  { key: 'touchCount', label: 'Msgs', hint: 'messages sent to this customer' },
  { key: 'firstSeenAt', label: 'Opened', hint: 'when the case was opened' },
]

export function CaseTable({
  rows,
  total,
}: {
  readonly rows: readonly CaseTableRow[]
  readonly total: number
}) {
  const [state, setState] = useState<string>('ALL')
  const [kind, setKind] = useState<string>('ALL')
  const [arm, setArm] = useState<string>('ALL')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'firstSeenAt',
    dir: 'desc',
  })

  const states = useMemo(
    () => ['ALL', ...[...new Set(rows.map((row) => row.state))].sort()],
    [rows],
  )

  const kinds = useMemo(() => ['ALL', ...[...new Set(rows.map((row) => row.type))].sort()], [rows])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = rows.filter((row) => {
      if (state !== 'ALL' && row.state !== state) return false
      if (kind !== 'ALL' && row.type !== kind) return false
      if (arm !== 'ALL' && row.arm !== arm) return false
      if (needle === '') return true
      return (
        row.id.toLowerCase().includes(needle) ||
        row.failureClass.toLowerCase().includes(needle) ||
        (row.cohortId ?? '').toLowerCase().includes(needle)
      )
    })

    return [...filtered].sort((a, b) => {
      const direction = sort.dir === 'asc' ? 1 : -1
      return (a[sort.key] - b[sort.key]) * direction
    })
  }, [rows, state, kind, arm, query, sort])

  const toggleSort = (key: SortKey): void =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' },
    )

  return (
    <div className="panel">
      <div className="filters" role="group" aria-label="Filter cases">
        <span className="panel-hint" id="filter-status">
          Status
        </span>
        {states.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="chip"
            data-active={state === candidate}
            aria-pressed={state === candidate}
            onClick={() => setState(candidate)}
          >
            {candidate === 'ALL' ? 'All' : candidate.toLowerCase().replaceAll('_', ' ')}
          </button>
        ))}

        <span className="panel-hint" style={{ marginLeft: 10 }}>
          Loss type
        </span>
        {kinds.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="chip"
            data-active={kind === candidate}
            aria-pressed={kind === candidate}
            onClick={() => setKind(candidate)}
          >
            {candidate === 'ALL' ? 'All' : candidate.toLowerCase().replaceAll('_', ' ')}
          </button>
        ))}

        <span className="panel-hint" style={{ marginLeft: 10 }}>
          Handled by
        </span>
        {[
          ['ALL', 'Either'],
          ['TREATMENT', 'The agent'],
          ['CONTROL', 'Old way'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="chip"
            data-active={arm === value}
            aria-pressed={arm === value}
            onClick={() => setArm(value as string)}
          >
            {label}
          </button>
        ))}

        <input
          className="search"
          style={{ marginLeft: 'auto' }}
          placeholder="Search id, failure, cohort…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search cases by id, failure class, or cohort"
          type="search"
        />
      </div>

      <div className="scroll-x">
        <table>
          <caption className="table-caption">
            Cases with the money owed, what went wrong, and how many messages were sent. Column
            headings with an arrow can be used to sort.
          </caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Loss type</th>
              <th scope="col">Status</th>
              <th scope="col">By</th>
              <th scope="col">What went wrong</th>
              <th scope="col">Route</th>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className="right"
                  scope="col"
                  aria-sort={
                    sort.key === column.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className="sortable"
                    title={column.hint}
                    onClick={() => toggleSort(column.key)}
                  >
                    {column.label}{' '}
                    {sort.key === column.key ? (
                      <span className="sort-arrow" data-dir={sort.dir} aria-hidden>
                        ▾
                      </span>
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                <td className="num">
                  <Link href={`/cases/${row.id}`} style={{ color: 'var(--accent)' }}>
                    {row.id}
                  </Link>
                </td>
                <td className="num dim">{row.type.toLowerCase().replaceAll('_', ' ')}</td>
                <td>
                  <span className={`tag ${STATE_TONE[row.state] ?? ''}`}>
                    {row.state.toLowerCase().replaceAll('_', ' ')}
                  </span>
                </td>
                <td className="num dim">{row.arm === 'TREATMENT' ? 'agent' : 'old way'}</td>
                <td className="num">{row.failureClass.toLowerCase().replaceAll('_', ' ')}</td>
                <td className="num dim">{row.cohortId ?? '-'}</td>
                <td className="right num">{row.amountLabel}</td>
                <td className="right num">
                  {row.recoveredPaise > 0 ? (
                    <span className="pos">{row.recoveredLabel}</span>
                  ) : (
                    <span className="dim">-</span>
                  )}
                </td>
                <td className="right num">{row.touchCount}</td>
                <td className="right num dim">{row.openedLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p aria-live="polite" className="visually-hidden">
        {visible.length} of {rows.length} cases shown
      </p>

      {visible.length === 0 ? (
        <div className="empty">
          {rows.length === 0
            ? 'No cases yet. Run npm run seed:console first.'
            : total > rows.length
              ? `No match among the ${rows.length.toLocaleString('en-IN')} most recent cases. This view holds the newest ${rows.length.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}, so an older case can exist without appearing here.`
              : 'No cases match these filters.'}
        </div>
      ) : (
        <div className="filters" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
          <span className="panel-hint num">
            {visible.length} shown of {rows.length} loaded
            {total > rows.length ? `, ${total.toLocaleString('en-IN')} in the batch` : ''} · click a
            column heading to sort · click a case id for its full history
          </span>
        </div>
      )}
    </div>
  )
}
