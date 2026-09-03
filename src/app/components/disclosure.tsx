'use client'

import { useId, useState } from 'react'

export interface DisclosureProps {
  readonly summary: React.ReactNode
  readonly children: React.ReactNode
  readonly defaultOpen?: boolean
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: DisclosureProps): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()

  return (
    <div data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        style={{
          appearance: 'none',
          background: 'none',
          border: 0,
          color: 'inherit',
          font: 'inherit',
          padding: 0,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        {summary}
      </button>

      <div className="disclosure" data-open={open} id={id}>
        <div className="disclosure-inner">
          <div className="disclosure-content">{children}</div>
        </div>
      </div>
    </div>
  )
}

export interface DisclosureRowProps {
  readonly cells: readonly React.ReactNode[]
  readonly children: React.ReactNode
  readonly columns: number
}

export function DisclosureRow({
  cells,
  children,
  columns,
}: DisclosureRowProps): React.ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <>
      <tr
        className="row-toggle"
        data-open={open}
        onClick={() => setOpen((value) => !value)}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        }}
      >
        {cells.map((cell, index) => (
          <td key={index}>
            {index === 0 ? <span className="caret">›</span> : null} {cell}
          </td>
        ))}
      </tr>
      <tr>
        <td colSpan={columns} style={{ padding: 0, border: 0 }}>
          <div className="disclosure" data-open={open}>
            <div className="disclosure-inner">
              <div
                className="disclosure-content"
                style={{ padding: open ? '10px 12px 14px 28px' : '0 12px 0 28px' }}
              >
                {children}
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  )
}
