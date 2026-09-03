export interface SparklineProps {
  readonly series: readonly number[]
  readonly width?: number
  readonly height?: number
  readonly stroke?: string
  readonly index?: number
}

export function Sparkline({
  series,
  width = 92,
  height = 20,
  stroke = 'var(--info)',
  index = 0,
}: SparklineProps): React.ReactElement | null {
  if (series.length < 2) return null

  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const step = width / (series.length - 1)

  const points = series
    .map((value, position) => {
      const x = position * step
      const y = height - ((value - min) / span) * (height - 3) - 1.5
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      className="draw"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ ['--len' as string]: width * 2, ['--i' as string]: index }}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export interface DivergingBarProps {
  readonly value: number
  readonly domain: number
  readonly index?: number
}

export function DivergingBar({ value, domain, index = 0 }: DivergingBarProps): React.ReactElement {
  const magnitude = Math.min(1, Math.abs(value) / domain)
  const positive = value >= 0

  return (
    <div
      style={{
        position: 'relative',
        height: 13,
        background: 'var(--surface-2)',
        borderRadius: 2,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          bottom: 0,
          width: 1,
          background: 'var(--line-bright)',
          zIndex: 1,
        }}
      />
      <div
        className="bar"
        style={{
          position: 'absolute',
          top: 0,
          [positive ? 'left' : 'right']: '50%',
          width: `${magnitude * 50}%`,
          background: positive ? 'var(--ok)' : 'var(--bad)',
          ['--origin' as string]: positive ? 'left center' : 'right center',
          animationDelay: `${index * 55}ms`,
        }}
      />
    </div>
  )
}

export interface QiniPoint {
  readonly x: number
  readonly y: number
}

export interface QiniCurveProps {
  readonly points: readonly QiniPoint[]
  readonly width?: number
  readonly height?: number
}

export function QiniCurve({
  points,
  width = 420,
  height = 200,
}: QiniCurveProps): React.ReactElement | null {
  if (points.length < 2) return null

  const maxX = Math.max(...points.map((point) => point.x)) || 1
  const values = points.map((point) => point.y)
  const maxY = Math.max(...values, 0)
  const minY = Math.min(...values, 0)
  const span = maxY - minY || 1

  const pad = 26
  const plotW = width - pad - 8
  const plotH = height - pad - 8

  const project = (point: QiniPoint): string => {
    const x = pad + (point.x / maxX) * plotW
    const y = 8 + plotH - ((point.y - minY) / span) * plotH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }

  const last = points.at(-1)
  const first = points[0]
  if (last === undefined || first === undefined) return null

  const zeroY = 8 + plotH - ((0 - minY) / span) * plotH

  return (
    <svg
      className="draw"
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      style={{ ['--len' as string]: 1400 }}
      role="img"
      aria-label="Qini curve against a random ranking"
    >
      <line
        x1={pad}
        y1={zeroY}
        x2={width - 8}
        y2={zeroY}
        stroke="var(--line-bright)"
        strokeWidth="1"
        style={{ ['--len' as string]: width }}
      />
      <line
        x1={pad}
        y1={project(first).split(',')[1]}
        x2={pad + plotW}
        y2={project(last).split(',')[1]}
        stroke="var(--text-faint)"
        strokeWidth="1"
        strokeDasharray="3 3"
        style={{ ['--len' as string]: width, ['--i' as string]: 1 }}
      />
      <polyline
        points={points.map(project).join(' ')}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.75"
        strokeLinejoin="round"
        style={{ ['--i' as string]: 2 }}
      />
    </svg>
  )
}
