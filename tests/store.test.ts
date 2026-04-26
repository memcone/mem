import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Store } from '../src/store'

const DB_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/mem_test'

describe('Store', () => {
  let store: Store

  beforeAll(async () => {
    store = new Store(DB_URL)
    await store.init()
  })

  afterAll(async () => {
    await store.close()
  })

  it('inserts facts and retrieves them by vector similarity', async () => {
    const scopeId = `test-${Date.now()}`
    const facts = ['user prefers dark mode']
    const embeddings = [Array(1536).fill(0.1) as number[]]

    await store.insert(scopeId, facts, embeddings, 1)

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(results.map(r => r.text)).toContain('user prefers dark mode')
  })

  it('only returns memories for the given scopeId', async () => {
    const ts = Date.now()
    const scopeA = `scope-a-${ts}`
    const scopeB = `scope-b-${ts}`

    await store.insert(scopeA, ['fact about A'], [Array(1536).fill(0.1) as number[]], 1)
    await store.insert(scopeB, ['fact about B'], [Array(1536).fill(0.9) as number[]], 1)

    const results = await store.search(scopeA, Array(1536).fill(0.1) as number[], 10)
    const texts = results.map(r => r.text)
    expect(texts).toContain('fact about A')
    expect(texts).not.toContain('fact about B')
  })

  it('inserts multiple facts from one call', async () => {
    const scopeId = `multi-${Date.now()}`
    const facts = ['user dislikes dashboards', 'user prefers minimal UI']
    const embeddings = [
      Array(1536).fill(0.2) as number[],
      Array(1536).fill(0.3) as number[],
    ]

    await store.insert(scopeId, facts, embeddings, 1)

    const results = await store.search(scopeId, Array(1536).fill(0.25) as number[], 10)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('upserts on duplicate fact — increments reinforcement_count instead of duplicating', async () => {
    const scopeId = `upsert-${Date.now()}`
    const facts = ['user prefers dark mode']
    const embeddings = [Array(1536).fill(0.1) as number[]]

    await store.insert(scopeId, facts, embeddings, 1)
    await store.insert(scopeId, facts, embeddings, 2)
    await store.insert(scopeId, facts, embeddings, 3)

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(results.length).toBe(1)
    expect(results[0].reinforcement_count).toBe(3)
  })

  it('upserts update last_touched_seq to the latest seq', async () => {
    const scopeId = `seq-${Date.now()}`
    const facts = ['user prefers dark mode']
    const embeddings = [Array(1536).fill(0.1) as number[]]

    await store.insert(scopeId, facts, embeddings, 1)
    await store.insert(scopeId, facts, embeddings, 5)

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(results[0].last_touched_seq).toBe(5)
  })

  it('semantically deduplicates near-identical preference phrasings', async () => {
    const scopeId = `semantic-dedup-${Date.now()}`
    const embeddings = [Array(1536).fill(0.1) as number[]]

    await store.insert(scopeId, ['[fact] user prefers remote work'], embeddings, 1)
    await store.insert(scopeId, ['[fact] user likes working from home'], embeddings, 2)

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(results).toHaveLength(1)
    expect(results[0].reinforcement_count).toBe(2)
    expect(results[0].last_touched_seq).toBe(2)
  })

  it('retrieves memories by linked entities', async () => {
    const scopeId = `entities-${Date.now()}`
    const ids = await store.insert(
      scopeId,
      ['[fact] Alice leads Project Atlas'],
      [Array(1536).fill(0.4) as number[]],
      1
    )

    await store.upsertEntities(scopeId, ids[0], ['Alice', 'Project Atlas'])

    const results = await store.searchByEntityMatches(scopeId, ['Alice'], 10)
    expect(results.map(result => result.text)).toContain('[fact] Alice leads Project Atlas')
    expect(results[0].entity_matches).toBeGreaterThanOrEqual(1)
  })

  it('retrieves exact facts through lexical search even when embeddings are not involved', async () => {
    const scopeId = `lexical-${Date.now()}`
    await store.insert(
      scopeId,
      ['[fact] Jira logged a TypeError in autocomplete.js', '[fact] User prefers dark mode'],
      [Array(1536).fill(0.4) as number[], Array(1536).fill(0.6) as number[]],
      1
    )

    const results = await store.searchLexical(scopeId, 'TypeError autocomplete.js', 10)

    expect(results.map(result => result.text)).toContain('[fact] Jira logged a TypeError in autocomplete.js')
    expect((results[0].lexical_score ?? 0)).toBeGreaterThan(0)
  })

  it('can filter lexical retrieval to instruction memories', async () => {
    const scopeId = `lexical-instruction-${Date.now()}`
    await store.insert(
      scopeId,
      ['[fact] user should use TypeScript for this project', '[fact] user likes fast tooling'],
      [Array(1536).fill(0.3) as number[], Array(1536).fill(0.5) as number[]],
      1,
      [
        { memoryType: 'instruction', scratchpadKey: 'instruction:typescript for this project' },
        { memoryType: 'state', scratchpadKey: 'state:fast tooling' },
      ]
    )

    const results = await store.searchLexical(scopeId, 'what should we use for this project', 10, {
      memoryType: 'instruction',
    })

    expect(results).toHaveLength(1)
    expect(results[0].memory_type).toBe('instruction')
    expect(results[0].text).toBe('[fact] user should use TypeScript for this project')
  })

  it('stores memory types and scratchpad updates', async () => {
    const scopeId = `typed-${Date.now()}`
    const ids = await store.insert(
      scopeId,
      ['[fact] user prefers dark mode'],
      [Array(1536).fill(0.1) as number[]],
      1,
      [{ memoryType: 'state', scratchpadKey: 'state:theme' }]
    )

    await store.upsertScratchpad(scopeId, 'state:theme', 'user prefers dark mode', ids[0], 1)

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(results[0].memory_type).toBe('state')
    expect(results[0].scratchpad_key).toBe('state:theme')

    const scratchpad = await store.getScratchpad(scopeId)
    expect(scratchpad[0].key).toBe('state:theme')
    expect(scratchpad[0].text).toBe('user prefers dark mode')
  })

  it('can supersede older state memories', async () => {
    const scopeId = `supersede-${Date.now()}`
    const embeddings = [Array(1536).fill(0.1) as number[]]
    const firstIds = await store.insert(
      scopeId,
      ['[fact] user likes dark mode'],
      embeddings,
      1,
      [{ memoryType: 'state', scratchpadKey: 'state:dark mode' }]
    )
    const secondIds = await store.insert(
      scopeId,
      ['[fact] user hates dark mode'],
      embeddings,
      2,
      [{ memoryType: 'state', scratchpadKey: 'state:dark mode' }]
    )

    await store.markSuperseded(scopeId, firstIds, secondIds[0])

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('[fact] user hates dark mode')
  })

  it('returns id, reinforcement_count, last_touched_seq, and created_at on each row', async () => {
    const scopeId = `meta-${Date.now()}`
    await store.insert(scopeId, ['user likes dark mode'], [Array(1536).fill(0.1) as number[]], 1)

    const results = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(typeof results[0].id).toBe('string')
    expect(results[0].id).toHaveLength(64) // sha256 hex
    expect(results[0].reinforcement_count).toBe(1)
    expect(results[0].last_touched_seq).toBe(1)
    expect(results[0].created_at).toBeInstanceOf(Date)
  })

  it('decay reduces reinforcement_count but never below 1', async () => {
    const scopeId = `decay-${Date.now()}`
    await store.insert(scopeId, ['user likes dark mode'], [Array(1536).fill(0.1) as number[]], 1)
    await store.insert(scopeId, ['user likes dark mode'], [Array(1536).fill(0.1) as number[]], 2)
    await store.insert(scopeId, ['user likes dark mode'], [Array(1536).fill(0.1) as number[]], 3)

    const before = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(before[0].reinforcement_count).toBe(3)

    await store.decay([before[0].id], 2)

    const after = await store.search(scopeId, Array(1536).fill(0.1) as number[], 10)
    expect(after[0].reinforcement_count).toBe(1)
  })
})
