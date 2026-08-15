import { describe, it, expect } from 'vitest'
import { decimalMultiply, decimalSum, decimalEquals, looksFloatContaminated } from '../lib/decimal'
describe('decimal helpers', () => {
  it('multiplies exactly where float fails', () => {
    expect(decimalMultiply('20', '1910.38')).toBe('38207.6')
    expect(20 * 1910.38).toBe(38207.600000000006) // float, for contrast
    expect(decimalMultiply('10', '1910.38')).toBe('19103.8')
    expect(decimalMultiply('1500', '0.00465')).toBe('6.975')
    expect(decimalMultiply('7.77', '1910.38')).toBe('14843.6526')
    expect(decimalMultiply('500000', '0.000028')).toBe('14')
  })
  it('sums exactly', () => {
    expect(decimalSum(['0.1', '0.2'])).toBe('0.3')
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(decimalSum(['38207.6', '19103.8', '6.975'])).toBe('57318.375')
  })
  it('compares ignoring representation', () => {
    expect(decimalEquals('38207.60', '38207.6')).toBe(true)
    expect(decimalEquals('38207.60', '38207.600000000006')).toBe(false)
  })
  it('detects float dust', () => {
    expect(looksFloatContaminated('38207.600000000006')).toBe(true)
    expect(looksFloatContaminated('19103.800000000003')).toBe(true)
    expect(looksFloatContaminated('38207.60')).toBe(false)
    expect(looksFloatContaminated('6.975')).toBe(false)
    expect(looksFloatContaminated('14843.6526')).toBe(false)
  })
})
