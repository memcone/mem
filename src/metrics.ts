import Redis from 'ioredis'

export type CallType = 'context_fast_hit' | 'context_fast_miss' | 'context_fresh' | 'remember' | 'recall'

export const UNITS: Record<CallType, number> = {
  context_fast_hit: 1,
  context_fast_miss: 3,
  context_fresh: 5,
  remember: 3,
  recall: 1,
}

export const FREE_UNITS = 10_000
export const UNIT_PRICE_PER_1K = 0.40

export interface MetricsSummary {
  units: number
  hits: number
  misses: number
  tokensSaved: number
  avgLatencyMs: number
  hitRate: number
  estimatedBillDollars: number
  totalCalls: number
  breakdown: {
    contextFastHit: number
    contextFastMiss: number
    contextFresh: number
    remember: number
    recall: number
  }
}

function billFromUnits(units: number): number {
  const overage = Math.max(0, units - FREE_UNITS)
  return (overage / 1000) * UNIT_PRICE_PER_1K
}

export class Metrics {
  private client: Redis

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false })
  }

  private prefix(subject: string): string {
    return `metrics:${subject}`
  }

  async record(subject: string, type: CallType, latencyMs: number, tokensSaved: number): Promise<void> {
    try {
      const p = this.prefix(subject)
      const units = UNITS[type]
      const isHit = type === 'context_fast_hit'
      const isMiss = type === 'context_fast_miss'

      const pipe = this.client.pipeline()
      pipe.incrby(`${p}:units`, units)
      pipe.incrby(`${p}:latency_sum`, latencyMs)
      pipe.incr(`${p}:calls`)
      pipe.incrby(`${p}:tokens_saved`, tokensSaved)
      pipe.incr(`${p}:type:${type}`)
      if (isHit) pipe.incr(`${p}:hits`)
      if (isMiss) pipe.incr(`${p}:misses`)
      await pipe.exec()
    } catch (error) {
      console.error('[mem.metrics] record failed', error)
    }
  }

  summaryFromUnits(units: number): MetricsSummary {
    return {
      units,
      hits: 0,
      misses: 0,
      tokensSaved: 0,
      avgLatencyMs: 0,
      hitRate: 0,
      estimatedBillDollars: billFromUnits(units),
      totalCalls: 0,
      breakdown: {
        contextFastHit: 0,
        contextFastMiss: 0,
        contextFresh: 0,
        remember: 0,
        recall: 0,
      },
    }
  }

  async summary(subject: string): Promise<MetricsSummary> {
    try {
      const p = this.prefix(subject)
      const [units, latencySum, calls, tokensSaved, hits, misses, contextFastHit, contextFastMiss, contextFresh, remember, recall] = await Promise.all([
        this.client.get(`${p}:units`),
        this.client.get(`${p}:latency_sum`),
        this.client.get(`${p}:calls`),
        this.client.get(`${p}:tokens_saved`),
        this.client.get(`${p}:hits`),
        this.client.get(`${p}:misses`),
        this.client.get(`${p}:type:context_fast_hit`),
        this.client.get(`${p}:type:context_fast_miss`),
        this.client.get(`${p}:type:context_fresh`),
        this.client.get(`${p}:type:remember`),
        this.client.get(`${p}:type:recall`),
      ])

      const u = parseInt(units ?? '0', 10)
      const lat = parseInt(latencySum ?? '0', 10)
      const c = parseInt(calls ?? '0', 10)
      const ts = parseInt(tokensSaved ?? '0', 10)
      const h = parseInt(hits ?? '0', 10)
      const m = parseInt(misses ?? '0', 10)
      const cfh = parseInt(contextFastHit ?? '0', 10)
      const cfm = parseInt(contextFastMiss ?? '0', 10)
      const cf = parseInt(contextFresh ?? '0', 10)
      const r = parseInt(remember ?? '0', 10)
      const rc = parseInt(recall ?? '0', 10)
      const contextCalls = h + m

      return {
        units: u,
        hits: h,
        misses: m,
        tokensSaved: ts,
        avgLatencyMs: c > 0 ? Math.round(lat / c) : 0,
        hitRate: contextCalls > 0 ? h / contextCalls : 0,
        estimatedBillDollars: billFromUnits(u),
        totalCalls: c,
        breakdown: {
          contextFastHit: cfh,
          contextFastMiss: cfm,
          contextFresh: cf,
          remember: r,
          recall: rc,
        },
      }
    } catch (error) {
      console.error('[mem.metrics] summary failed', error)
      return this.summaryFromUnits(0)
    }
  }

  async flushTestKeys(): Promise<void> {
    const keys = await this.client.keys('metrics:test-*')
    if (keys.length) await this.client.del(...keys)
  }

  async close(): Promise<void> {
    await this.client.quit()
  }
}
