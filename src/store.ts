import { createHash, randomUUID } from 'crypto'
import { Pool } from 'pg'

const SCHEMA_VERSION = 9

export type MemoryType =
  | 'event'
  | 'state'
  | 'instruction'
  | 'summary'

export type MemoryRow = {
  id: string
  text: string
  memory_type?: MemoryType
  scratchpad_key?: string | null
  superseded_by?: string | null
  superseded_at?: Date | null
  reinforcement_count: number
  last_touched_seq: number
  created_at: Date
  similarity?: number
  lexical_score?: number
  entity_matches?: number
}

export type ScratchpadRow = {
  key: string
  text: string
  source_memory_id: string | null
  updated_seq: number
  updated_at: Date
}

export type RetrievedBelief = {
  id: string
  text: string
  strength: number
  similarity: number
  lane?: string
  reason?: string
  source?: string
  rank?: number
}

export type TraceLaneCounts = {
  total?: number
  beliefs?: number
  events?: number
  facts?: number
  links?: number
  scratchpad?: number
}

export type TraceMemoryTypeCounts = Partial<Record<MemoryType | 'scratchpad', number>>

export type TraceBudgetInfo = {
  full_replay_tokens?: number
  selected_tokens?: number
  context_tokens?: number
  prompt_tokens?: number
  saved_tokens?: number
}

export type TracePackedSection = {
  key: string
  label?: string
  item_count?: number
  token_estimate?: number
}

export type TraceDebugInfo = {
  strategy?: string
  reranked?: boolean
  dropped_for_budget?: number
  stale_filtered?: number
  contradiction_filtered?: number
}

export type TraceMetadata = {
  query_type?: string
  latency_ms?: number
  candidates?: TraceLaneCounts
  selected?: TraceLaneCounts
  candidate_memory_types?: TraceMemoryTypeCounts
  selected_memory_types?: TraceMemoryTypeCounts
  budget?: TraceBudgetInfo
  packed_sections?: TracePackedSection[]
  debug?: TraceDebugInfo
}

export type TraceRow = {
  id: string
  endpoint: 'context' | 'recall'
  query: string
  cache_hit: boolean
  retrieved: RetrievedBelief[]
  created_at: Date
  query_type?: string
  latency_ms?: number
  candidates?: TraceLaneCounts
  selected?: TraceLaneCounts
  budget?: TraceBudgetInfo
  packed_sections?: TracePackedSection[]
  debug?: TraceDebugInfo
}

function normalizeSemanticKey(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/^\[(?:fact|event)\]\s*/i, '')
    .replace(/\b(working from home|work from home|wfh)\b/g, 'remote work')
    .replace(/\b(likes|like|loves|love|prefers|prefer|wants|want|uses|use)\b/g, 'positive')
    .replace(/\b(hates|hate|dislikes|dislike|avoids|avoid|never)\b/g, 'negative')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(the|a|an|to|for|with|from|is|are|was|were|again|really|strongly|absolutely|currently|now)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const LEXICAL_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'that', 'the', 'their',
  'them', 'they', 'this', 'to', 'user', 'was', 'we', 'were', 'what', 'when', 'where',
  'who', 'why', 'with', 'would', 'you', 'your',
])

function buildLexicalTsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s.-]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !LEXICAL_STOPWORDS.has(token))

  return Array.from(new Set(tokens)).map(token => `${token}:*`).join(' | ')
}

function memoryId(scopeId: string, text: string): string {
  return createHash('sha256')
    .update(`${scopeId}::${normalizeSemanticKey(text)}`)
    .digest('hex')
}

function normalizeMemoryType(value: string | null | undefined): MemoryType {
  if (value === 'event') return 'event'
  if (value === 'instruction') return 'instruction'
  if (value === 'summary') return 'summary'
  return 'state'
}

export class Store {
  private pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector')

      await client.query(`
        CREATE TABLE IF NOT EXISTS mem_schema (
          version INTEGER NOT NULL
        )
      `)

      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM mem_schema LIMIT 1'
      )
      const currentVersion = rows[0]?.version ?? 0

      if (currentVersion < 3) {
        await client.query('DROP TABLE IF EXISTS mem_memories')
        await client.query(`
          CREATE TABLE mem_memories (
            id                  TEXT PRIMARY KEY,
            scope_id            TEXT NOT NULL,
            text                TEXT NOT NULL,
            embedding           vector(1536) NOT NULL,
            reinforcement_count INTEGER NOT NULL DEFAULT 1,
            last_touched_seq    BIGINT  NOT NULL DEFAULT 1,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_embedding_idx
          ON mem_memories USING hnsw (embedding vector_cosine_ops)
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_scope_idx
          ON mem_memories (scope_id)
        `)
      }

      if (currentVersion < 4) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS mem_retrieval_log (
            id          TEXT PRIMARY KEY,
            scope_id    TEXT NOT NULL,
            endpoint    TEXT NOT NULL,
            query       TEXT NOT NULL,
            cache_hit   BOOLEAN NOT NULL DEFAULT false,
            retrieved   JSONB NOT NULL DEFAULT '[]',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_retrieval_log_scope_idx
          ON mem_retrieval_log (scope_id, created_at DESC)
        `)
      }

      if (currentVersion < 5) {
        await client.query(`
          ALTER TABLE mem_retrieval_log
          ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'
        `)
      }

      if (currentVersion < 6) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS mem_entities (
            scope_id     TEXT NOT NULL,
            entity_key   TEXT NOT NULL,
            display_text TEXT NOT NULL,
            mention_count INTEGER NOT NULL DEFAULT 1,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (scope_id, entity_key)
          )
        `)
        await client.query(`
          CREATE TABLE IF NOT EXISTS mem_memory_entities (
            scope_id    TEXT NOT NULL,
            memory_id   TEXT NOT NULL,
            entity_key  TEXT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (scope_id, memory_id, entity_key)
          )
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memory_entities_scope_entity_idx
          ON mem_memory_entities (scope_id, entity_key)
        `)
      }

      if (currentVersion < 7) {
        await client.query(`
          ALTER TABLE mem_memories
          ADD COLUMN IF NOT EXISTS memory_type TEXT NOT NULL DEFAULT 'fact'
        `)
        await client.query(`
          ALTER TABLE mem_memories
          ADD COLUMN IF NOT EXISTS scratchpad_key TEXT
        `)
        await client.query(`
          ALTER TABLE mem_memories
          ADD COLUMN IF NOT EXISTS superseded_by TEXT
        `)
        await client.query(`
          ALTER TABLE mem_memories
          ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_scope_type_idx
          ON mem_memories (scope_id, memory_type, last_touched_seq DESC)
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_scope_active_idx
          ON mem_memories (scope_id, last_touched_seq DESC)
          WHERE superseded_by IS NULL
        `)
        await client.query(`
          CREATE TABLE IF NOT EXISTS mem_scratchpad (
            scope_id         TEXT NOT NULL,
            key              TEXT NOT NULL,
            text             TEXT NOT NULL,
            source_memory_id TEXT,
            updated_seq      BIGINT NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (scope_id, key)
          )
        `)
      }

      if (currentVersion < 8) {
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_scope_scratchpad_idx
          ON mem_memories (scope_id, scratchpad_key, last_touched_seq DESC)
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_scope_superseded_idx
          ON mem_memories (scope_id, superseded_by, last_touched_seq DESC)
        `)
      }

      if (currentVersion < 9) {
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_text_fts_idx
          ON mem_memories
          USING gin (to_tsvector('simple', regexp_replace(text, '^\\[(fact|event)\\]\\s*', '', 'i')))
        `)
        await client.query(`
          CREATE INDEX IF NOT EXISTS mem_memories_scope_type_active_idx
          ON mem_memories (scope_id, memory_type, last_touched_seq DESC)
          WHERE superseded_by IS NULL
        `)
      }

      if (currentVersion < SCHEMA_VERSION) {
        await client.query('DELETE FROM mem_schema')
        await client.query('INSERT INTO mem_schema (version) VALUES ($1)', [SCHEMA_VERSION])
      }
    } finally {
      client.release()
    }
  }

  async insert(
    scopeId: string,
    facts: string[],
    embeddings: number[][],
    seq: number,
    metadata: Array<{ memoryType?: MemoryType; scratchpadKey?: string | null }> = []
  ): Promise<string[]> {
    const client = await this.pool.connect()
    const ids: string[] = []
    try {
      for (let i = 0; i < facts.length; i++) {
        const id = memoryId(scopeId, facts[i])
        ids.push(id)
        const memoryType = metadata[i]?.memoryType ?? 'state'
        const scratchpadKey = metadata[i]?.scratchpadKey ?? null
        await client.query(
          `INSERT INTO mem_memories (id, scope_id, text, embedding, last_touched_seq, memory_type, scratchpad_key)
           VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             reinforcement_count = mem_memories.reinforcement_count + 1,
             last_touched_seq    = EXCLUDED.last_touched_seq,
             memory_type         = EXCLUDED.memory_type,
             scratchpad_key      = COALESCE(EXCLUDED.scratchpad_key, mem_memories.scratchpad_key),
             updated_at          = now()`,
          [id, scopeId, facts[i], `[${embeddings[i].join(',')}]`, seq, memoryType, scratchpadKey]
        )
      }
      return ids
    } finally {
      client.release()
    }
  }

  async search(scopeId: string, queryEmbedding: number[], limit: number): Promise<MemoryRow[]> {
    const result = await this.pool.query<MemoryRow & { similarity: number }>(
      `SELECT id, text, memory_type, scratchpad_key, superseded_by, superseded_at, reinforcement_count, last_touched_seq::integer, created_at,
              (1 - (embedding <=> $2::vector)) AS similarity
       FROM mem_memories
       WHERE scope_id = $1
         AND superseded_by IS NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [scopeId, `[${queryEmbedding.join(',')}]`, limit]
    )
    return result.rows
  }

  async searchLexical(
    scopeId: string,
    query: string,
    limit: number,
    options: { memoryType?: MemoryType } = {}
  ): Promise<MemoryRow[]> {
    const lexicalQuery = buildLexicalTsQuery(query)
    if (!lexicalQuery) return []

    const clauses = [
      `scope_id = $1`,
      `superseded_by IS NULL`,
      `to_tsvector('simple', regexp_replace(text, '^\\[(fact|event)\\]\\s*', '', 'i')) @@ to_tsquery('simple', $2)`,
    ]
    const params: Array<string | number> = [scopeId, lexicalQuery, limit]

    if (options.memoryType) {
      clauses.push(`memory_type = $4`)
      params.push(options.memoryType)
    }

    const result = await this.pool.query<MemoryRow & { lexical_score: string }>(
      `SELECT id, text, memory_type, scratchpad_key, superseded_by, superseded_at, reinforcement_count, last_touched_seq::integer, created_at,
              ts_rank_cd(
                to_tsvector('simple', regexp_replace(text, '^\\[(fact|event)\\]\\s*', '', 'i')),
                to_tsquery('simple', $2)
              )::text AS lexical_score
       FROM mem_memories
       WHERE ${clauses.join('\n         AND ')}
       ORDER BY ts_rank_cd(
         to_tsvector('simple', regexp_replace(text, '^\\[(fact|event)\\]\\s*', '', 'i')),
         to_tsquery('simple', $2)
       ) DESC,
       last_touched_seq DESC
       LIMIT $3`,
      params
    )

    return result.rows.map(row => ({
      ...row,
      memory_type: normalizeMemoryType(row.memory_type),
      lexical_score: parseFloat(row.lexical_score) || 0,
    }))
  }

  async upsertEntities(scopeId: string, memoryId: string, entities: string[]): Promise<void> {
    if (entities.length === 0) return

    const normalizedMap = new Map<string, { display: string; key: string }>()
    for (const rawEntity of entities) {
      const display = rawEntity.trim()
      if (!display) continue
      const key = display.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
      if (key.length < 2) continue
      normalizedMap.set(key, { display, key })
    }
    const normalized = Array.from(normalizedMap.values())

    const client = await this.pool.connect()
    try {
      for (const entity of normalized) {
        await client.query(
          `INSERT INTO mem_entities (scope_id, entity_key, display_text)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope_id, entity_key) DO UPDATE SET
             mention_count = mem_entities.mention_count + 1,
             display_text = EXCLUDED.display_text,
             updated_at = now()`,
          [scopeId, entity.key, entity.display]
        )

        await client.query(
          `INSERT INTO mem_memory_entities (scope_id, memory_id, entity_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope_id, memory_id, entity_key) DO NOTHING`,
          [scopeId, memoryId, entity.key]
        )
      }
    } finally {
      client.release()
    }
  }

  async searchByEntityMatches(scopeId: string, entities: string[], limit: number): Promise<MemoryRow[]> {
    const normalized = Array.from(new Set(
      entities
        .map(entity => entity.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    ))
    if (normalized.length === 0) return []

    const result = await this.pool.query<MemoryRow & { entity_matches: string }>(
      `SELECT
         m.id,
         m.text,
         m.memory_type,
         m.scratchpad_key,
         m.superseded_by,
         m.superseded_at,
         m.reinforcement_count,
         m.last_touched_seq::integer,
         m.created_at,
         COUNT(*)::text AS entity_matches
       FROM mem_memories m
       INNER JOIN mem_memory_entities mme
         ON mme.scope_id = m.scope_id
        AND mme.memory_id = m.id
       WHERE m.scope_id = $1
         AND m.superseded_by IS NULL
         AND mme.entity_key = ANY($2)
       GROUP BY m.id, m.text, m.memory_type, m.scratchpad_key, m.superseded_by, m.superseded_at, m.reinforcement_count, m.last_touched_seq, m.created_at
       ORDER BY COUNT(*) DESC, m.last_touched_seq DESC
       LIMIT $3`,
      [scopeId, normalized, limit]
    )

    return result.rows.map(row => ({
      ...row,
      memory_type: normalizeMemoryType(row.memory_type),
      entity_matches: parseInt(row.entity_matches, 10) || 0,
    }))
  }

  async getSeqRange(scopeId: string, seq: number, window: number): Promise<MemoryRow[]> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT id, text, memory_type, scratchpad_key, superseded_by, superseded_at, reinforcement_count, last_touched_seq::integer, created_at
       FROM mem_memories
       WHERE scope_id = $1
         AND last_touched_seq >= $2::integer - $3::integer
         AND last_touched_seq <= $2::integer + $3::integer
       ORDER BY last_touched_seq ASC`,
      [scopeId, seq, window]
    )
    return result.rows
  }

  async getTopicVersions(scopeId: string, scratchpadKey: string, limit = 8): Promise<MemoryRow[]> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT id, text, memory_type, scratchpad_key, superseded_by, superseded_at, reinforcement_count, last_touched_seq::integer, created_at
       FROM mem_memories
       WHERE scope_id = $1
         AND scratchpad_key = $2
       ORDER BY last_touched_seq DESC
       LIMIT $3`,
      [scopeId, scratchpadKey, limit]
    )
    return result.rows.map(row => ({
      ...row,
      memory_type: normalizeMemoryType(row.memory_type),
    }))
  }

  async markSuperseded(scopeId: string, ids: string[], supersedingId: string): Promise<void> {
    if (ids.length === 0) return
    await this.pool.query(
      `UPDATE mem_memories
       SET superseded_by = $3,
           superseded_at = now(),
           updated_at = now()
       WHERE scope_id = $1
         AND id = ANY($2)
         AND id <> $3`,
      [scopeId, ids, supersedingId]
    )
  }

  async upsertScratchpad(
    scopeId: string,
    key: string,
    text: string,
    sourceMemoryId: string | null,
    updatedSeq: number
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mem_scratchpad (scope_id, key, text, source_memory_id, updated_seq)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope_id, key) DO UPDATE SET
         text = EXCLUDED.text,
         source_memory_id = EXCLUDED.source_memory_id,
         updated_seq = EXCLUDED.updated_seq,
         updated_at = now()`,
      [scopeId, key, text, sourceMemoryId, updatedSeq]
    )
  }

  async getScratchpad(scopeId: string): Promise<ScratchpadRow[]> {
    const result = await this.pool.query<ScratchpadRow>(
      `SELECT key, text, source_memory_id, updated_seq::integer, updated_at
       FROM mem_scratchpad
       WHERE scope_id = $1
       ORDER BY updated_seq DESC, updated_at DESC`,
      [scopeId]
    )
    return result.rows
  }

  async logRetrieval(
    scopeId: string,
    endpoint: 'context' | 'recall',
    query: string,
    cacheHit: boolean,
    retrieved: RetrievedBelief[],
    metadata: TraceMetadata = {}
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mem_retrieval_log (id, scope_id, endpoint, query, cache_hit, retrieved, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), scopeId, endpoint, query, cacheHit, JSON.stringify(retrieved), JSON.stringify(metadata)]
    )
  }

  async listTraces(userId: string, scopeId: string, limit = 20): Promise<TraceRow[]> {
    const fullScopeId = `${userId}:${scopeId}`
    const { rows } = await this.pool.query<{
      id: string
      endpoint: string
      query: string
      cache_hit: boolean
      retrieved: RetrievedBelief[]
      metadata: TraceMetadata
      created_at: Date
    }>(
      `SELECT id, endpoint, query, cache_hit, retrieved, metadata, created_at
       FROM mem_retrieval_log
       WHERE scope_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [fullScopeId, limit]
    )
    return rows.map(r => ({
      id: r.id,
      endpoint: r.endpoint as 'context' | 'recall',
      query: r.query,
      cache_hit: r.cache_hit,
      retrieved: r.retrieved,
      created_at: r.created_at,
      ...(r.metadata ?? {}),
    }))
  }

  async listAllTraces(userId: string, limit = 50): Promise<(TraceRow & { scopeId: string })[]> {
    const prefix = `${userId}:`
    const { rows } = await this.pool.query<{
      id: string
      scope_id: string
      endpoint: string
      query: string
      cache_hit: boolean
      retrieved: RetrievedBelief[]
      metadata: TraceMetadata
      created_at: Date
    }>(
      `SELECT id, scope_id, endpoint, query, cache_hit, retrieved, metadata, created_at
       FROM mem_retrieval_log
       WHERE scope_id LIKE $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [`${prefix}%`, limit]
    )
    return rows.map(r => ({
      id: r.id,
      scopeId: r.scope_id.slice(prefix.length),
      endpoint: r.endpoint as 'context' | 'recall',
      query: r.query,
      cache_hit: r.cache_hit,
      retrieved: r.retrieved,
      created_at: r.created_at,
      ...(r.metadata ?? {}),
    }))
  }

  async decay(ids: string[], delta: number): Promise<void> {
    if (ids.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query(
        `UPDATE mem_memories
         SET reinforcement_count = GREATEST(1, reinforcement_count - $1),
             updated_at          = now()
         WHERE id = ANY($2)`,
        [delta, ids]
      )
    } finally {
      client.release()
    }
  }

  async listScopes(userId: string): Promise<ScopeInfo[]> {
    const prefix = `${userId}:`
    const { rows } = await this.pool.query<{
      scope_id: string
      belief_count: string
      last_updated: Date
    }>(
      `SELECT scope_id, COUNT(*) AS belief_count, MAX(updated_at) AS last_updated
       FROM mem_memories
       WHERE scope_id LIKE $1
       GROUP BY scope_id
       ORDER BY last_updated DESC`,
      [`${prefix}%`]
    )
    return rows.map(r => ({
      scopeId: r.scope_id.slice(prefix.length),
      beliefCount: parseInt(r.belief_count, 10),
      lastUpdated: r.last_updated,
    }))
  }

  async listBeliefs(userId: string, scopeId: string): Promise<BeliefInfo[]> {
    const fullScopeId = `${userId}:${scopeId}`
    const { rows } = await this.pool.query<{
      id: string
      text: string
      memory_type: string
      scratchpad_key: string | null
      superseded_by: string | null
      reinforcement_count: number
      last_touched_seq: number
      created_at: Date
      updated_at: Date
      strength: string
    }>(
      `WITH scope_beliefs AS (
         SELECT
           id, text, memory_type, scratchpad_key, superseded_by, reinforcement_count, last_touched_seq, created_at, updated_at,
           MAX(last_touched_seq) OVER () AS current_seq
         FROM mem_memories
         WHERE scope_id = $1
           AND superseded_by IS NULL
       )
       SELECT
         id, text, memory_type, scratchpad_key, superseded_by, reinforcement_count, last_touched_seq, created_at, updated_at,
         reinforcement_count::float8 / (
           (1.0 + EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) *
           (1.0 + (current_seq - last_touched_seq) * 0.1)
         ) AS strength
       FROM scope_beliefs
       ORDER BY strength DESC`,
      [fullScopeId]
    )
    return rows.map(r => {
      const strength = parseFloat(r.strength)
      return {
        id: r.id,
        text: r.text,
        memory_type: normalizeMemoryType(r.memory_type),
        scratchpad_key: r.scratchpad_key ?? null,
        superseded_by: r.superseded_by ?? null,
        reinforcement_count: r.reinforcement_count,
        last_touched_seq: r.last_touched_seq,
        created_at: r.created_at,
        updated_at: r.updated_at,
        strength,
        decay_state: strength > 3.5 ? 'stable' : strength > 2 ? 'moderate' : 'decaying',
      }
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export type ScopeInfo = {
  scopeId: string
  beliefCount: number
  lastUpdated: Date
}

export type BeliefInfo = {
  id: string
  text: string
  memory_type?: MemoryType
  scratchpad_key?: string | null
  superseded_by?: string | null
  reinforcement_count: number
  last_touched_seq: number
  created_at: Date
  updated_at: Date
  strength: number
  decay_state: 'stable' | 'moderate' | 'decaying'
}
