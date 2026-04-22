import { describe, it, expect } from 'vitest'
import { countTokens } from '../src/tokens'

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('returns positive count for non-empty text', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0)
  })

  it('longer text produces more tokens', () => {
    const short = countTokens('hello')
    const long = countTokens('hello world this is a longer sentence with more words')
    expect(long).toBeGreaterThan(short)
  })

  it('counts known text accurately', () => {
    // "Hello, world!" tokenizes to 4 tokens with cl100k_base
    expect(countTokens('Hello, world!')).toBe(4)
  })
})
