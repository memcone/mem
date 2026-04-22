import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SemanticLLM } from '../src/llm'
import type { Store, MemoryRow } from '../src/store'

function makeMemoryRow(text: string, reinforcement_count = 1, last_touched_seq = 1): MemoryRow {
  return { id: `id-${text}`, text, reinforcement_count, last_touched_seq, created_at: new Date() }
}

function makeStore(): Store {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(['id-1']),
    search: vi.fn().mockResolvedValue([]),
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
  } as unknown as Store
}

function makeLLM(): SemanticLLM {
  return {
    embed: vi.fn().mockResolvedValue(Array(1536).fill(0.1)),
    embedMany: vi.fn().mockResolvedValue([Array(1536).fill(0.1)]),
    extract: vi.fn().mockResolvedValue(['extracted fact']),
    extractEntities: vi.fn().mockResolvedValue([]),
    compress: vi.fn().mockResolvedValue('compressed belief'),
    formatContext: vi.fn().mockResolvedValue('formatted context block'),
    contradicts: vi.fn().mockResolvedValue([]),
  }
}

describe('engine.remember', () => {
  let store: Store
  let llm: SemanticLLM

  beforeEach(() => {
    store = makeStore()
    llm = makeLLM()
  })

  it('extracts facts from a string event and stores them', async () => {
    const { remember } = await import('../src/engine')
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      'user dislikes dashboards',
      'user prefers minimal UI',
    ])
    ;(store.insert as ReturnType<typeof vi.fn>).mockResolvedValue(['id-a', 'id-b'])
    ;(llm.embed as ReturnType<typeof vi.fn>).mockResolvedValue(Array(1536).fill(0.5))
    ;(llm.embedMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      Array(1536).fill(0.5),
      Array(1536).fill(0.5),
    ])
    ;(llm.extractEntities as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(['dashboards'])
      .mockResolvedValueOnce(['minimal UI'])

    await remember(store, llm, 'user-1', 'I hate dashboards and want simple UI', 1)

    expect(llm.extract).toHaveBeenCalledWith('I hate dashboards and want simple UI')
    expect(llm.embedMany).toHaveBeenCalledWith([
      '[fact] user dislikes dashboards',
      '[fact] user prefers minimal UI',
    ])
    expect(store.insert).toHaveBeenCalledWith(
      'user-1',
      ['[fact] user dislikes dashboards', '[fact] user prefers minimal UI'],
      [Array(1536).fill(0.5), Array(1536).fill(0.5)],
      1,
      [
        { memoryType: 'state', scratchpadKey: 'state:dashboards' },
        { memoryType: 'state', scratchpadKey: 'state:minimal ui' },
      ]
    )
    expect(store.upsertEntities).toHaveBeenNthCalledWith(1, 'user-1', 'id-a', ['dashboards'])
    expect(store.upsertEntities).toHaveBeenNthCalledWith(2, 'user-1', 'id-b', ['minimal UI'])
    expect(store.upsertScratchpad).toHaveBeenNthCalledWith(1, 'user-1', 'state:dashboards', 'user dislikes dashboards', 'id-a', 1)
    expect(store.upsertScratchpad).toHaveBeenNthCalledWith(2, 'user-1', 'state:minimal ui', 'user prefers minimal UI', 'id-b', 1)
  })

  it('stores raw event memories for event-like inputs so chronology survives retrieval', async () => {
    const { remember } = await import('../src/engine')
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      'user moved to Berlin last year',
    ])
    ;(store.insert as ReturnType<typeof vi.fn>).mockResolvedValue(['id-event', 'id-fact'])
    ;(llm.embedMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      Array(1536).fill(0.1),
      Array(1536).fill(0.1),
    ])

    await remember(store, llm, 'user-1', 'User moved to Berlin last year', 3)

    expect(store.insert).toHaveBeenCalledWith(
      'user-1',
      ['[event] User moved to Berlin last year', '[fact] user moved to Berlin last year'],
      [Array(1536).fill(0.1), Array(1536).fill(0.1)],
      3,
      [
        { memoryType: 'event', scratchpadKey: null },
        { memoryType: 'event', scratchpadKey: null },
      ]
    )
  })

  it('normalizes API key beliefs into a stable topic key', async () => {
    const { remember } = await import('../src/engine')
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      'user has an API key for the project',
    ])
    ;(store.insert as ReturnType<typeof vi.fn>).mockResolvedValue(['id-api'])
    ;(llm.embedMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      Array(1536).fill(0.1),
    ])

    await remember(store, llm, 'user-1', 'I have an API key for this project', 4)

    expect(store.insert).toHaveBeenCalledWith(
      'user-1',
      ['[fact] user has an API key for the project'],
      [Array(1536).fill(0.1)],
      4,
      [{ memoryType: 'state', scratchpadKey: 'state:api_key' }]
    )
  })

  it('normalizes Flask route beliefs into a stable topic key', async () => {
    const { remember } = await import('../src/engine')
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      'user is implementing a basic homepage route with Flask',
    ])
    ;(store.insert as ReturnType<typeof vi.fn>).mockResolvedValue(['id-route'])
    ;(llm.embedMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      Array(1536).fill(0.1),
    ])

    await remember(store, llm, 'user-1', 'I implemented a basic homepage route with Flask', 5)

    expect(store.insert).toHaveBeenCalledWith(
      'user-1',
      ['[fact] user is implementing a basic homepage route with Flask'],
      [Array(1536).fill(0.1)],
      5,
      [{ memoryType: 'state', scratchpadKey: 'state:flask_routes' }]
    )
  })

  it('normalizes a JSON object event to a string before extracting', async () => {
    const { remember } = await import('../src/engine')

    await remember(store, llm, 'user-1', { action: 'clicked', target: 'dark mode toggle' }, 1)

    expect(llm.extract).toHaveBeenCalledWith(
      JSON.stringify({ action: 'clicked', target: 'dark mode toggle' })
    )
  })

  it('truncates oversized remember input before extraction so giant turns do not crash embeddings', async () => {
    const { remember } = await import('../src/engine')
    const giant = 'Massive payload '.repeat(4000)
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue([giant])
    ;(store.insert as ReturnType<typeof vi.fn>).mockResolvedValue(['id-giant'])
    ;(llm.embedMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      Array(1536).fill(0.1),
    ])

    await remember(store, llm, 'user-1', giant, 1)

    const extractArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    const embedArg = (llm.embedMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.[0] as string

    expect(extractArg.length).toBeLessThan(giant.length)
    expect(embedArg.length).toBeLessThan(giant.length)
    expect(store.insert).toHaveBeenCalled()
  })

  it('skips low-signal object turns when they only contain acknowledgement text', async () => {
    const { remember } = await import('../src/engine')

    const result = await remember(store, llm, 'user-1', { role: 'assistant', content: 'Sounds good.' }, 1)

    expect(result).toEqual({ facts: [], stored: 0, contradictions_resolved: 0 })
    expect(llm.extract).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
  })

  it('skips short ephemeral questions that do not express memory-worthy state', async () => {
    const { remember } = await import('../src/engine')

    const result = await remember(store, llm, 'user-1', 'Can you help me?', 1)

    expect(result).toEqual({ facts: [], stored: 0, contradictions_resolved: 0 })
    expect(llm.extract).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
  })

  it('still remembers short questions when they carry a real memory signal', async () => {
    const { remember } = await import('../src/engine')
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue(['user needs a reminder tomorrow'])
    ;(store.insert as ReturnType<typeof vi.fn>).mockResolvedValue(['id-reminder'])
    ;(llm.embedMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      Array(1536).fill(0.1),
    ])

    await remember(store, llm, 'user-1', 'Can you remind me tomorrow?', 1)

    expect(llm.extract).toHaveBeenCalledWith('Can you remind me tomorrow?')
    expect(store.insert).toHaveBeenCalled()
  })

  it('skips low-signal turns so acknowledgements do not hit the memory pipeline', async () => {
    const { remember } = await import('../src/engine')

    const result = await remember(store, llm, 'user-1', 'ok', 1)

    expect(result).toEqual({ facts: [], stored: 0, contradictions_resolved: 0 })
    expect(llm.extract).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
  })

  it('decays contradicting memories when contradicts() returns matches', async () => {
    const { remember } = await import('../src/engine')
    const existing = makeMemoryRow('user likes dark mode', 3)
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([existing])
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue(['user hates dark mode'])
    ;(llm.contradicts as ReturnType<typeof vi.fn>).mockResolvedValue(['user likes dark mode'])

    await remember(store, llm, 'user-1', 'I hate dark mode now', 5)

    expect(store.decay).toHaveBeenCalledWith([existing.id], 1)
  })

  it('does not call decay when no contradictions are found', async () => {
    const { remember } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryRow('user prefers compact layouts'),
    ])
    ;(llm.extract as ReturnType<typeof vi.fn>).mockResolvedValue(['user likes dark mode'])
    ;(llm.contradicts as ReturnType<typeof vi.fn>).mockResolvedValue([])

    await remember(store, llm, 'user-1', 'I like dark mode', 2)

    expect(store.decay).not.toHaveBeenCalled()
  })
})

describe('engine.recall', () => {
  let store: Store
  let llm: SemanticLLM

  beforeEach(() => {
    store = makeStore()
    llm = makeLLM()
  })

  it('embeds query, searches store, and returns ranked memories directly', async () => {
    const { recall } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryRow('user dislikes dashboards', 3),
      makeMemoryRow('user prefers minimal UI', 1),
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await recall(store, llm, 'user-1', 'UI preferences', 10)

    expect(llm.embed).toHaveBeenCalledWith('UI preferences')
    expect(store.search).toHaveBeenCalledWith('user-1', Array(1536).fill(0.1), 20)
    expect(result).toContain('user dislikes dashboards')
    expect(result).toContain('user prefers minimal UI')
    expect(store.logRetrieval).toHaveBeenCalled()
  })

  it('returns empty string when no memories exist for scope', async () => {
    const { recall } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await recall(store, llm, 'new-user', 'anything', 0)

    expect(store.logRetrieval).not.toHaveBeenCalled()
    expect(result).toBe('')
  })

  it('sorts memories by strength descending before returning', async () => {
    const { recall } = await import('../src/engine')
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { text: 'weak old belief', reinforcement_count: 1, last_touched_seq: 1, created_at: old },
      makeMemoryRow('strong recent belief', 20),
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await recall(store, llm, 'user-1', 'query', 5)

    expect(result.split('\n')[0]).toMatch(/strong recent belief/)
  })

  it('deprioritizes stale beliefs via seqLag — fresh memory outranks lightly-reinforced old one', async () => {
    const { recall } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryRow('old stale belief', 2, 1),   // seq=1, reinforcement=2 → strength=2/(1+1.9)≈0.69
      makeMemoryRow('fresh new belief', 1, 20),   // seq=20, reinforcement=1 → strength=1/1=1.0
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await recall(store, llm, 'user-1', 'query', 20)

    expect(result.split('\n')[0]).toMatch(/fresh new belief/)
  })

  it('boosts memories returned from entity matches even when semantic retrieval is sparse', async () => {
    const { recall } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryRow('user likes tea', 1, 2),
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...makeMemoryRow('[fact] Alice owns Project Atlas', 2, 9), entity_matches: 2 },
    ])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(llm.extractEntities as ReturnType<typeof vi.fn>).mockResolvedValue(['Alice', 'Project Atlas'])

    const result = await recall(store, llm, 'user-1', 'What is Alice doing with Project Atlas?', 10)

    expect(result.split('\n')[0]).toContain('Alice owns Project Atlas')
  })
})

describe('engine.context', () => {
  let store: Store
  let llm: SemanticLLM

  beforeEach(() => {
    store = makeStore()
    llm = makeLLM()
  })

  it('embeds task, searches store, and returns structured context blocks', async () => {
    const { context } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryRow('user prefers minimal UI', 5),
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await context(store, llm, 'user-1', 'build a settings page', 5)

    expect(llm.embed).toHaveBeenCalledWith('build a settings page')
    expect(result.result).toContain('## Rules & Preferences')
    expect(result.result).toContain('user prefers minimal UI')
    expect(result.query_type).toBeDefined()
    expect(store.logRetrieval).toHaveBeenCalled()
  })

  it('drops older contradictory preference stances when a newer opposite stance exists', async () => {
    const { context } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', text: '[fact] user likes dark mode', reinforcement_count: 5, last_touched_seq: 4, created_at: new Date() },
      { id: '2', text: '[fact] user hates dark mode', reinforcement_count: 3, last_touched_seq: 9, created_at: new Date() },
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await context(store, llm, 'user-1', 'what theme should we use?', 9)

    expect(result.result).toContain('user hates dark mode')
    expect(result.result).not.toContain('user likes dark mode')
  })

  it('includes sequence markers for event-ordering context', async () => {
    const { context } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', text: '[event] user moved to Berlin', reinforcement_count: 1, last_touched_seq: 3, created_at: new Date() },
      { id: '2', text: '[event] user moved to Amsterdam', reinforcement_count: 1, last_touched_seq: 8, created_at: new Date() },
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await context(store, llm, 'user-1', 'where did the user move after Berlin?', 8)

    expect(result.result).toContain('[seq 3] user moved to Berlin')
    expect(result.result).toContain('[seq 8] user moved to Amsterdam')
  })

  it('returns empty string when no memories exist for scope', async () => {
    const { context } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await context(store, llm, 'new-user', 'any task', 0)

    expect(store.logRetrieval).not.toHaveBeenCalled()
    expect(result.result).toBe('')
  })

  it('injects scratchpad state into context retrieval', async () => {
    const { context } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        key: 'preference:theme',
        text: 'user prefers dark mode',
        source_memory_id: 'm1',
        updated_seq: 9,
        updated_at: new Date(),
      },
    ])

    const result = await context(store, llm, 'user-1', 'what theme should we use?', 9)

    expect(result.result).toContain('user prefers dark mode')
  })

  it('retrieves both active and historical topic versions for conflict questions', async () => {
    const { context } = await import('../src/engine')
    ;(store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'active',
        text: '[fact] user has an API key for the project',
        memory_type: 'state',
        scratchpad_key: 'state:api_key',
        reinforcement_count: 3,
        last_touched_seq: 10,
        created_at: new Date(),
      },
    ])
    ;(store.searchByEntityMatches as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getScratchpad as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(store.getTopicVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'active',
        text: '[fact] user has an API key for the project',
        memory_type: 'state',
        scratchpad_key: 'state:api_key',
        reinforcement_count: 3,
        last_touched_seq: 10,
        created_at: new Date(),
      },
      {
        id: 'old',
        text: '[fact] user has never obtained an API key for the project',
        memory_type: 'state',
        scratchpad_key: 'state:api_key',
        superseded_by: 'active',
        reinforcement_count: 2,
        last_touched_seq: 4,
        created_at: new Date(),
      },
    ])

    const result = await context(store, llm, 'user-1', 'Have I obtained an API key for this project?', 10)

    expect(result.query_type).toBe('conflict')
    expect(result.result).toContain('[current] user has an API key for the project')
    expect(result.result).toContain('[historical] user has never obtained an API key for the project')
    expect(store.getTopicVersions).toHaveBeenCalledWith('user-1', 'state:api_key', 6)
  })
})
