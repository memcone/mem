import { describe, it, expect, vi } from 'vitest'
import { remember } from '../src/engine'
import type { Store } from '../src/store'
import type { SemanticLLM } from '../src/llm'
import type { Cache } from '../src/cache'

function makeStore(): Store {
  return {
    insert: vi.fn().mockResolvedValue(['id-1']),
    search: vi.fn().mockResolvedValue([]),
    searchByEntityMatches: vi.fn().mockResolvedValue([]),
    getTopicVersions: vi.fn().mockResolvedValue([]),
    upsertEntities: vi.fn().mockResolvedValue(undefined),
    upsertScratchpad: vi.fn().mockResolvedValue(undefined),
    getScratchpad: vi.fn().mockResolvedValue([]),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
    getSeqRange: vi.fn().mockResolvedValue([]),
    logRetrieval: vi.fn(),
    decay: vi.fn(),
  } as unknown as Store
}

function makeLLM(): SemanticLLM {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    embedMany: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    extract: vi.fn().mockResolvedValue(['user hates onboarding']),
    extractEntities: vi.fn().mockResolvedValue([]),
    compress: vi.fn(),
    formatContext: vi.fn(),
    contradicts: vi.fn().mockResolvedValue([]),
  } as unknown as SemanticLLM
}

function makeNoopLLM(): SemanticLLM {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    embedMany: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    extract: vi.fn().mockResolvedValue([]),
    extractEntities: vi.fn().mockResolvedValue([]),
    compress: vi.fn(),
    formatContext: vi.fn(),
    contradicts: vi.fn().mockResolvedValue([]),
  } as unknown as SemanticLLM
}

function makeCache(): Cache {
  return {
    bumpVersion: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn(),
    setContext: vi.fn(),
    flushTestKeys: vi.fn(),
    close: vi.fn(),
  } as unknown as Cache
}

describe('remember() with cache', () => {
  it('bumps cache version after storing memories', async () => {
    const cache = makeCache()
    await remember(makeStore(), makeLLM(), 'scope1', 'user hates long flows', 1, { cache })
    expect(cache.bumpVersion).toHaveBeenCalledWith('scope1')
  })

  it('does not call bumpVersion when no cache provided', async () => {
    const cache = makeCache()
    await remember(makeStore(), makeLLM(), 'scope1', 'user hates long flows', 1)
    expect(cache.bumpVersion).not.toHaveBeenCalled()
  })

  it('does not bump cache version when remember stores nothing', async () => {
    const cache = makeCache()
    await remember(makeStore(), makeNoopLLM(), 'scope1', { assistant: 'okay' }, 1, { cache })
    expect(cache.bumpVersion).not.toHaveBeenCalled()
  })
})
