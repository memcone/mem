import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/store', () => ({
  Store: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(['id-1']),
    search: vi.fn().mockResolvedValue([]),
    searchLexical: vi.fn().mockResolvedValue([]),
    searchByEntityMatches: vi.fn().mockResolvedValue([]),
    getTopicVersions: vi.fn().mockResolvedValue([]),
    upsertEntities: vi.fn().mockResolvedValue(undefined),
    upsertScratchpad: vi.fn().mockResolvedValue(undefined),
    getScratchpad: vi.fn().mockResolvedValue([]),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
    getSeqRange: vi.fn().mockResolvedValue([]),
    logRetrieval: vi.fn().mockResolvedValue(undefined),
    decay: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('../src/llm', () => ({
  OpenAISemanticLLM: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(Array(1536).fill(0.1)),
    embedMany: vi.fn().mockResolvedValue([Array(1536).fill(0.1)]),
    extract: vi.fn().mockResolvedValue(['user prefers dark mode']),
    extractEntities: vi.fn().mockResolvedValue([]),
    compress: vi.fn().mockResolvedValue('User prefers dark mode.'),
    formatContext: vi.fn().mockResolvedValue('The user prefers dark mode.'),
    contradicts: vi.fn().mockResolvedValue([]),
  })),
}))

import { createMem } from '../src/index'

const config = {
  db: 'postgres://localhost:5432/mem_test',
  llm: { provider: 'openai' as const, apiKey: 'fake-key' },
}

describe('createMem', () => {
  it('returns an object with remember, recall, and context methods', () => {
    const mem = createMem(config)
    expect(typeof mem.remember).toBe('function')
    expect(typeof mem.recall).toBe('function')
    expect(typeof mem.context).toBe('function')
  })

  it('remember resolves without throwing', async () => {
    const mem = createMem(config)
    await expect(mem.remember('user-1', 'I like dark mode')).resolves.toMatchObject({
      stored: expect.any(Number),
      contradictions_resolved: expect.any(Number),
    })
  })

  it('recall returns a string', async () => {
    const mem = createMem(config)
    const result = await mem.recall('user-1', 'color preferences')
    expect(typeof result).toBe('string')
  })

  it('context returns a ContextResult with result string', async () => {
    const mem = createMem(config)
    const result = await mem.context('user-1', 'build a theme settings page')
    expect(typeof result.result).toBe('string')
    expect(typeof result.cache_hit).toBe('boolean')
    expect(typeof result.tokens_saved).toBe('number')
  })

  it('init is called only once across multiple method calls', async () => {
    const { Store } = await import('../src/store')
    const mem = createMem(config)

    await mem.remember('user-1', 'event one')
    await mem.recall('user-1', 'query')
    await mem.context('user-1', 'task')

    const storeInstance = (Store as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value
    expect(storeInstance.init).toHaveBeenCalledTimes(1)
  })
})
