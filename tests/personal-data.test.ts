import { describe, expect, it } from 'vitest'

import { assertNoPii, findPii, rehydratePii, tokenisePii } from '../src/core/personal-data'

describe('findPii', () => {
  it('finds an email address', () => {
    const found = findPii('write to asha.k@example.com please')
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('EMAIL')
    expect(found[0]?.value).toBe('asha.k@example.com')
  })

  it('finds an Indian mobile number with and without the country code', () => {
    expect(findPii('call 9876543210')[0]?.kind).toBe('PHONE')
    expect(findPii('call +919876543210')[0]?.value).toBe('+919876543210')
    expect(findPii('call 91 9876543210')[0]?.kind).toBe('PHONE')
  })

  it('ignores a landline-shaped number that cannot be a mobile', () => {
    expect(findPii('ref 1234567890')).toHaveLength(0)
  })

  it('finds a card number only when it passes Luhn', () => {
    expect(findPii('card 4111111111111111')[0]?.kind).toBe('CARD')
    expect(findPii('card 4111111111111112')).toHaveLength(0)
  })

  it('finds a card number written with spaces', () => {
    const found = findPii('card 4111 1111 1111 1111')
    expect(found[0]?.kind).toBe('CARD')
  })

  it('finds a PAN and an IFSC code', () => {
    expect(findPii('PAN ABCDE1234F')[0]?.kind).toBe('PAN')
    expect(findPii('IFSC HDFC0001234')[0]?.kind).toBe('IFSC')
  })

  it('finds an Aadhaar-shaped number without mistaking it for a mobile', () => {
    const found = findPii('id 234567890123')
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('AADHAAR')
  })

  it('finds a UPI handle but prefers the email reading when there is a domain', () => {
    expect(findPii('pay asha@okhdfcbank')[0]?.kind).toBe('VPA')
    expect(findPii('mail asha@example.com')[0]?.kind).toBe('EMAIL')
  })

  it('returns nothing for clean text', () => {
    expect(findPii('your subscription renewal did not go through')).toEqual([])
  })

  it('does not emit overlapping findings', () => {
    const found = findPii('reach asha@example.com or 9876543210')
    expect(found).toHaveLength(2)
    expect(found[0]?.end).toBeLessThanOrEqual(found[1]?.start ?? 0)
  })
})

describe('tokenisePii', () => {
  it('replaces every finding with a typed placeholder', () => {
    const { text } = tokenisePii('mail asha@example.com or call 9876543210')
    expect(text).toBe('mail {{EMAIL_1}} or call {{PHONE_1}}')
  })

  it('gives the same value the same token so the model sees a consistent entity', () => {
    const { text, map } = tokenisePii('9876543210 then 9876543210 then 9812345670')
    expect(text).toBe('{{PHONE_1}} then {{PHONE_1}} then {{PHONE_2}}')
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('leaves clean text untouched with an empty map', () => {
    const input = 'your payment did not go through'
    expect(tokenisePii(input)).toEqual({ text: input, map: {} })
  })

  it('round-trips exactly', () => {
    const input = 'asha@example.com paid via asha@okhdfcbank, call +919876543210, PAN ABCDE1234F'
    const { text, map } = tokenisePii(input)
    expect(text).not.toContain('asha@example.com')
    expect(text).not.toContain('9876543210')
    expect(rehydratePii(text, map)).toBe(input)
  })

  it('produces text that carries no remaining PII', () => {
    const { text } = tokenisePii('asha@example.com 9876543210 4111111111111111 ABCDE1234F')
    expect(findPii(text)).toEqual([])
  })
})

describe('assertNoPii', () => {
  it('passes clean text', () => {
    expect(() => assertNoPii('outstanding amount is due', 'model payload')).not.toThrow()
  })

  it('throws with the context and the kinds found', () => {
    expect(() => assertNoPii('call 9876543210', 'model payload')).toThrow(
      /PII_MINIMISATION violated in model payload.*PHONE/s,
    )
  })
})
