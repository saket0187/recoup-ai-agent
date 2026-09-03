'use client'

import { useEffect, useState } from 'react'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export interface OdometerProps {
  readonly value: string
}

export function Odometer({ value }: OdometerProps): React.ReactElement {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <span className="odometer">
      <span className="visually-hidden">{value}</span>
      <span className="odo-reel" aria-hidden>
        {[...value].map((character, index) => {
          const digit = DIGITS.indexOf(character)

          if (digit < 0) {
            return <span key={index}>{character}</span>
          }

          return (
            <span className="odo-col" key={index}>
              <span
                className="odo-strip"
                style={{
                  transform: `translateY(-${ready ? digit : 0}em)`,
                  ['--i' as string]: index,
                }}
              >
                {DIGITS.map((candidate) => (
                  <span key={candidate}>{candidate}</span>
                ))}
              </span>
            </span>
          )
        })}
      </span>
    </span>
  )
}
