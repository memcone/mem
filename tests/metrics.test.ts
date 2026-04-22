import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Metrics, UNITS, FREE_UNITS, UNIT_PRICE_PER_1K } from '../src/metrics'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

describe('Metrics', () => {
  let metrics: Metrics

  beforeAll(async () => {
    metrics = new Metrics(REDIS_URL)
  })

  afterAll(async () => {
    await metrics.close()
  })

  beforeEach(async () => {
    await metrics.flushTestKeys()
  })

  it('UNITS weights are correct', () => {
    expect(UNITS.context_fast_hit).toBe(1)
    expect(UNITS.context_fast_miss).toBe(3)
    expect(UNITS.context_fresh).toBe(5)
    expect(UNITS.remember).toBe(3)
    expect(UNITS.recall).toBe(1)
  })

  it('FREE_UNITS is 10000', () => {
    expect(FREE_UNITS).toBe(10_000)
  })

  it('UNIT_PRICE_PER_1K is 0.40', () => {
    expect(UNIT_PRICE_PER_1K).toBe(0.40)
  })

  it('record increments units and hits', async () => {
    await metrics.record('test-scope', 'context_fast_hit', 100, 50)
    const s = await metrics.summary('test-scope')
    expect(s.units).toBe(1)
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(0)
    expect(s.tokensSaved).toBe(50)
    expect(s.totalCalls).toBe(1)
    expect(s.breakdown.contextFastHit).toBe(1)
  })

  it('record increments units and misses for fast miss', async () => {
    await metrics.record('test-scope', 'context_fast_miss', 200, 0)
    const s = await metrics.summary('test-scope')
    expect(s.units).toBe(3)
    expect(s.misses).toBe(1)
    expect(s.hits).toBe(0)
    expect(s.breakdown.contextFastMiss).toBe(1)
  })

  it('record increments units for recall', async () => {
    await metrics.record('test-scope', 'recall', 120, 0)
    const s = await metrics.summary('test-scope')
    expect(s.units).toBe(1)
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
    expect(s.breakdown.recall).toBe(1)
  })

  it('summary computes hitRate', async () => {
    await metrics.record('test-scope', 'context_fast_hit', 80, 30)
    await metrics.record('test-scope', 'context_fast_hit', 90, 30)
    await metrics.record('test-scope', 'context_fast_miss', 300, 0)
    const s = await metrics.summary('test-scope')
    expect(s.hitRate).toBeCloseTo(2 / 3)
  })

  it('summary returns zero values when no data', async () => {
    const s = await metrics.summary('test-scope')
    expect(s.units).toBe(0)
    expect(s.hitRate).toBe(0)
  })

  it('estimatedBillDollars returns 0 within free tier', async () => {
    await metrics.record('test-scope', 'context_fast_hit', 50, 0)
    const s = await metrics.summary('test-scope')
    expect(s.estimatedBillDollars).toBe(0)
  })

  it('estimatedBillDollars charges only overage above free tier', async () => {
    // 10001 units → 1 unit overage → $0.40/1000 = $0.0004
    const s = await metrics.summaryFromUnits(10_001)
    expect(s.estimatedBillDollars).toBeCloseTo(0.40 / 1000)
  })
})
