declare const PaiseBrand: unique symbol

export type Paise = number & { readonly [PaiseBrand]: true }

export const ZERO_PAISE = 0 as Paise

export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `paise(): money must be a safe integer number of paise, got ${value}. ` +
        `Fractional paise means a float leaked onto the money path.`,
    )
  }
  return value as Paise
}

export function fromRupees(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new RangeError(`fromRupees(): expected a finite number, got ${rupees}`)
  }
  const scaled = Math.round(rupees * 100)
  if (Math.abs(rupees * 100 - scaled) > 1e-6) {
    throw new RangeError(
      `fromRupees(): ${rupees} does not land on a whole paise. Round explicitly at the source.`,
    )
  }
  return paise(scaled)
}

export function toRupees(value: Paise): number {
  return value / 100
}

export function addP(...values: readonly Paise[]): Paise {
  let total = 0
  for (const value of values) total += value
  return paise(total)
}

export function subP(a: Paise, b: Paise): Paise {
  return paise(a - b)
}

export function sumPaise(values: Iterable<Paise>): Paise {
  let total = 0
  for (const value of values) total += value
  return paise(total)
}

export function scaleP(value: Paise, factor: number): Paise {
  if (!Number.isFinite(factor)) {
    throw new RangeError(`scaleP(): factor must be finite, got ${factor}`)
  }
  return paise(Math.round(value * factor))
}

export function pctOf(value: Paise, percent: number): Paise {
  return scaleP(value, percent / 100)
}

function maxP(a: Paise, b: Paise): Paise {
  return a >= b ? a : b
}

function minP(a: Paise, b: Paise): Paise {
  return a <= b ? a : b
}

export function clampP(value: Paise, lower: Paise, upper: Paise): Paise {
  if (lower > upper) throw new RangeError('clampP(): lower bound exceeds upper bound')
  return minP(maxP(value, lower), upper)
}

export function splitPaise(total: Paise, parts: number): Paise[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`splitPaise(): parts must be a positive integer, got ${parts}`)
  }
  const base = Math.trunc(total / parts)
  const out: Paise[] = []
  let allocated = 0
  for (let i = 0; i < parts - 1; i++) {
    out.push(paise(base))
    allocated += base
  }
  out.push(paise(total - allocated))
  return out
}

const GROUP_FORMATTER = new Intl.NumberFormat('en-IN', {
  useGrouping: true,
  maximumFractionDigits: 0,
})

export function formatINR(value: Paise): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const whole = Math.trunc(abs / 100)
  const fraction = abs % 100
  return `${sign}₹${GROUP_FORMATTER.format(whole)}.${String(fraction).padStart(2, '0')}`
}

const CRORE = 1_000_000_000
const LAKH = 10_000_000
const THOUSAND = 100_000

export function formatINRCompact(value: Paise): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const render = (divisor: number, suffix: string): string => {
    const fixed = (abs / divisor).toFixed(2)
    const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
    return `${sign}₹${trimmed}${suffix}`
  }
  if (abs >= CRORE) return render(CRORE, 'Cr')
  if (abs >= LAKH) return render(LAKH, 'L')
  if (abs >= THOUSAND) return render(THOUSAND, 'k')
  return formatINR(value)
}
