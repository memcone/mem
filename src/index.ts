import { Store } from './store'
export type { ScopeInfo, BeliefInfo, TraceRow, RetrievedBelief } from './store'
import { OpenAISemanticLLM } from './llm'
import { Cache } from './cache'
import { Metrics } from './metrics'
import * as engine from './engine'
import type { ContextResult } from './engine'

export type { ContextResult } from './engine'
export type { ContextOptions, RememberOptions } from './engine'
export type { CachedContext } from './cache'
export type { MetricsSummary, CallType } from './metrics'
export { UNITS, FREE_UNITS, UNIT_PRICE_PER_1K } from './metrics'

export interface MemConfig {
  db: string
  llm: {
    provider: 'openai'
    apiKey: string
  }
  redis?: string
}

export interface Mem {
  store: Store
  remember(scopeId: string, event: string | object): Promise<engine.RememberResult>
  recall(scopeId: string, query: string): Promise<string>
  context(scopeId: string, task: string, options?: engine.ContextOptions): Promise<ContextResult>
  cache?: Cache
  metrics?: Metrics
}

export function createMem(config: MemConfig): Mem {
  const store = new Store(config.db)
  const llm = new OpenAISemanticLLM(config.llm.apiKey)
  const cache = config.redis ? new Cache(config.redis) : undefined
  const metrics = config.redis ? new Metrics(config.redis) : undefined

  let initialized = false
  const scopeCounters = new Map<string, number>()

  async function ensureInit(): Promise<void> {
    if (!initialized) {
      await store.init()
      initialized = true
    }
  }

  function nextSeq(scopeId: string): number {
    const seq = (scopeCounters.get(scopeId) ?? 0) + 1
    scopeCounters.set(scopeId, seq)
    return seq
  }

  function currentSeq(scopeId: string): number {
    return scopeCounters.get(scopeId) ?? 0
  }

  return {
    store,
    cache,
    metrics,
    async remember(scopeId: string, event: string | object): Promise<engine.RememberResult> {
      await ensureInit()
      return engine.remember(store, llm, scopeId, event, nextSeq(scopeId), { cache })
    },
    async recall(scopeId: string, query: string): Promise<string> {
      await ensureInit()
      return engine.recall(store, llm, scopeId, query, currentSeq(scopeId))
    },
    async context(scopeId: string, task: string, options: engine.ContextOptions = {}): Promise<ContextResult> {
      await ensureInit()
      return engine.context(store, llm, scopeId, task, currentSeq(scopeId), Date.now(), { cache, ...options })
    },
  }
}
