'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'

export const GLOSSARY = {
  incremental: {
    title: 'Incremental recovery',
    plain:
      'Money we got back that would NOT have arrived on its own. Not total collected, just the extra our actions caused.',
    why: 'Most overdue payments arrive eventually without any chasing. Counting those as a win would flatter us.',
  },
  control: {
    title: 'Control group',
    plain:
      'One case in five is handled the old way instead, on a fixed schedule of 3 retries, 1 SMS and 1 email. We never let the agent touch them.',
    why: 'They are the comparison. Without them we could not tell whether the agent helped or the money just came in anyway.',
  },
  confidence: {
    title: '95% confidence interval',
    plain:
      'The range the true answer probably sits in. If the range crosses zero, we cannot claim a real effect yet.',
    why: 'A single number hides how much of it might be luck. The range shows it.',
  },
  pp: {
    title: 'Percentage points (pp)',
    plain:
      'The gap between two percentages. If we recover 47% and the control recovers 45%, that is +2pp.',
    why: 'Saying "4% better" is ambiguous. This makes it exact.',
  },
  uplift: {
    title: 'Uplift',
    plain:
      'How much a specific action changes the chance of getting paid, compared with doing nothing.',
    why: 'Some people pay anyway, and some get annoyed and leave. Uplift can be negative, and we do not hide it when it is.',
  },
  qini: {
    title: 'Qini score',
    plain:
      'A grade from roughly 0 to 1 for how well the model picks who to contact. 0 means it is guessing.',
    why: 'Ordinary accuracy scores reward predicting who pays. We need who responds to being contacted, which is a different question.',
  },
  propensity: {
    title: 'Propensity',
    plain:
      'The chance the agent would have picked this exact action, recorded at the moment it decided.',
    why: 'Without it saved at decision time, we could never fairly evaluate a different strategy later. It cannot be reconstructed afterwards.',
  },
  stopGate: {
    title: 'Stop gate',
    plain:
      '18 hard rules that can halt an action: already paid, disputed, opted out, bereaved, budget spent.',
    why: 'It runs twice: when deciding, and again just before sending, because things change in between.',
  },
  policyGate: {
    title: 'Policy gate',
    plain:
      '35 compliance rules covering quiet hours, consent, do-not-disturb, and how often we may contact someone.',
    why: 'It is deterministic code, not a model. Nothing can talk it round, and a rule that errors counts as a refusal.',
  },
  wilson: {
    title: 'Wilson lower bound',
    plain:
      'A cautious estimate of a success rate. With few attempts it stays low until there is enough evidence.',
    why: 'Stops us declaring an outage on a handful of unlucky failures.',
  },
  incumbentFloor: {
    title: 'Incumbent floor',
    plain:
      'If the agent has no better idea, it does what the old fixed schedule would have done rather than nothing.',
    why: 'A replacement should never quietly do less than what it replaces. It can still deliberately stop.',
  },
  dryRun: {
    title: 'Dry run',
    plain:
      'Nothing is actually sent or charged. Every decision is made and recorded as if it were.',
    why: 'The default. Going live needs an explicit flag and a confirmation.',
  },
  ev: {
    title: 'EV (expected value)',
    plain:
      'What an action is worth on average before we take it: the extra chance it wins the payment, times the amount owed, minus what it costs to send.',
    why: 'A ₹50 reminder that adds 1% to a ₹40,000 invoice is worth sending. The same reminder on a ₹200 bill is not. EV is how that gets decided per case rather than by a blanket rule.',
  },
  cohort: {
    title: 'Cohort (method × issuer)',
    plain:
      'A payment method paired with the bank behind it, like UPI on HDFC or a card issued by SBI. Failures cluster this way in reality: an outage hits one bank on one rail, not everyone.',
    why: 'Grouping this way is how payment teams actually monitor. It lets us pause retries into a bank that is down without touching customers whose payments would work fine.',
  },
  bandit: {
    title: 'Bandit',
    plain:
      'A running tally of how often each action has worked, kept separately per action, time of day, and failure type, and updated as outcomes arrive.',
    why: 'It supplies the exploration: the agent occasionally tries something other than its current best guess, which is what keeps the estimates honest and makes later re-analysis possible.',
  },
  arm: {
    title: 'Arm',
    plain: 'Which group a case is in: treatment (the agent) or control (the fixed schedule).',
    why: 'Assigned by a hash of the case id, so it is random but reproducible.',
  },
  failureClass: {
    title: 'Failure class',
    plain:
      'What actually went wrong, in one of 8 buckets: no money, expired card, bank outage, broken mandate, and so on.',
    why: 'Each needs a different response. Retrying a dead card forever is pointless; retrying a bank blip works.',
  },
} as const

export type TermKey = keyof typeof GLOSSARY

const TIP_WIDTH = 290
const TIP_GAP = 8
const VIEWPORT_MARGIN = 10

interface TipPosition {
  readonly left: number
  readonly top: number
  readonly below: boolean
}

export function Term({
  name,
  children,
}: {
  readonly name: TermKey
  readonly children?: React.ReactNode
}): React.ReactElement {
  const [position, setPosition] = useState<TipPosition | undefined>(undefined)
  const anchor = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const id = useId()
  const entry = GLOSSARY[name]
  const open = position !== undefined

  const place = useCallback((): void => {
    const button = anchor.current
    if (button === null) return

    const rect = button.getBoundingClientRect()
    const height = tip.current?.offsetHeight ?? 0
    const roomAbove = rect.top
    const below = height > 0 && roomAbove < height + TIP_GAP + VIEWPORT_MARGIN

    const maxLeft = window.innerWidth - TIP_WIDTH - VIEWPORT_MARGIN
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft))
    const top = below ? rect.bottom + TIP_GAP : rect.top - TIP_GAP - height

    setPosition({ left, top, below })
  }, [])

  useEffect(() => {
    if (!open) return
    place()

    const dismiss = (): void => setPosition(undefined)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, place])

  return (
    <span className="term-wrap">
      <button
        ref={anchor}
        type="button"
        className="term"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={place}
        onMouseLeave={() => setPosition(undefined)}
        onFocus={place}
        onBlur={() => setPosition(undefined)}
        onClick={() => (open ? setPosition(undefined) : place())}
      >
        {children ?? entry.title}
      </button>
      <span
        ref={tip}
        className="tip"
        role="tooltip"
        id={id}
        data-open={open}
        data-below={position?.below === true}
        style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
      >
        <span className="tip-title">{entry.title}</span>
        <span className="tip-plain">{entry.plain}</span>
        <span className="tip-why">{entry.why}</span>
      </span>
    </span>
  )
}
