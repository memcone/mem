import { describe, it, expect, vi, beforeEach } from 'vitest'
import { context, ContextResult } from '../src/engine'
import type { Store } from '../src/store'
import type { SemanticLLM } from '../src/llm'
import type { Cache } from '../src/cache'

function makeStore(rows: any[] = []): Store {
  return {
    search: vi.fn().mockResolvedValue(rows),
    searchLexical: vi.fn().mockResolvedValue([]),
    searchByEntityMatches: vi.fn().mockResolvedValue([]),
    getTopicVersions: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(['id-1']),
    upsertEntities: vi.fn().mockResolvedValue(undefined),
    upsertScratchpad: vi.fn().mockResolvedValue(undefined),
    getScratchpad: vi.fn().mockResolvedValue([]),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
    getSeqRange: vi.fn().mockResolvedValue([]),
    decay: vi.fn().mockResolvedValue(undefined),
    logRetrieval: vi.fn().mockResolvedValue(undefined),
  } as unknown as Store
}

function makeLLM(result = 'User likes dark mode.'): SemanticLLM {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedMany: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    extractEntities: vi.fn().mockResolvedValue([]),
    formatContext: vi.fn().mockResolvedValue(result),
    extract: vi.fn(),
    compress: vi.fn(),
    contradicts: vi.fn(),
  } as unknown as SemanticLLM
}

function makeCache(hit: string | null = null): Cache {
  return {
    getContext: vi.fn().mockResolvedValue(hit ? { result: hit, tokens_saved: 5 } : null),
    setContext: vi.fn().mockResolvedValue(undefined),
    bumpVersion: vi.fn(),
    flushTestKeys: vi.fn(),
    close: vi.fn(),
  } as unknown as Cache
}

describe('context() with cache', () => {
  it('returns result without cache when no cache provided', async () => {
    const store = makeStore([{ text: 't', id: '1', reinforcement_count: 1, last_touched_seq: 0, created_at: new Date().toISOString() }])
    const llm = makeLLM('User likes dark mode.')
    const res: ContextResult = await context(store, llm, 'scope1', 'greet user', 0)
    expect(res.result).toContain('##')
    expect(res.result).toContain('- t')
    expect(res.cache_hit).toBe(false)
    expect(res.tokens_saved).toBeGreaterThanOrEqual(0)
  })

  it('returns cache hit when mode=fast and cache has entry', async () => {
    const store = makeStore()
    const llm = makeLLM()
    const cache = makeCache('User likes dark mode.')
    const res = await context(store, llm, 'scope1', 'greet user', 0, Date.now(), { cache, mode: 'fast' })
    expect(res.result).toBe('User likes dark mode.')
    expect(res.cache_hit).toBe(true)
    expect(res.tokens_saved).toBeGreaterThan(0)
    expect(store.logRetrieval).toHaveBeenCalled()
  })

  it('calls LLM and stores in cache on cache miss', async () => {
    const store = makeStore([{ text: 't', id: '1', reinforcement_count: 1, last_touched_seq: 0, created_at: new Date().toISOString() }])
    const llm = makeLLM('fresh result')
    const cache = makeCache(null)
    const res = await context(store, llm, 'scope1', 'greet user', 0, Date.now(), { cache, mode: 'fast' })
    expect(res.result).toContain('##')
    expect(res.cache_hit).toBe(false)
    expect(cache.setContext).toHaveBeenCalled()
  })

  it('bypasses cache when mode=fresh', async () => {
    const store = makeStore([{ text: 't', id: '1', reinforcement_count: 1, last_touched_seq: 0, created_at: new Date().toISOString() }])
    const llm = makeLLM('fresh result')
    const cache = makeCache('cached result')
    const res = await context(store, llm, 'scope1', 'greet user', 0, Date.now(), { cache, mode: 'fresh' })
    expect(res.result).toContain('##')
    expect(res.cache_hit).toBe(false)
    expect(cache.getContext).not.toHaveBeenCalled()
  })

  it('returns sources when debug=true', async () => {
    const rows = [{ text: 'User likes dark mode.', id: '1', reinforcement_count: 3, last_touched_seq: 0, created_at: new Date().toISOString() }]
    const store = makeStore(rows)
    const llm = makeLLM('User likes dark mode.')
    const res = await context(store, llm, 'scope1', 'greet user', 0, Date.now(), { debug: true })
    expect(res.sources).toBeDefined()
    expect(res.sources!.length).toBeGreaterThan(0)
  })
})
