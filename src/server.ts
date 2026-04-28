import express from 'express'
import { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { createMem } from './index'
import type { CallType } from './metrics'

const app = express()
const jsonLimit = process.env.JSON_BODY_LIMIT ?? '2mb'
app.use(express.json({ limit: jsonLimit }))

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const mem = createMem({
  db: process.env.DATABASE_URL!,
  llm: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  redis: process.env.REDIS_URL,
})


function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Internal server error'
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

async function validateApiKey(key: string): Promise<string | null> {
  const hashed = hashApiKey(key)
  let rows: Array<{ user_id: string }>

  try {
    const result = await pool.query(
      'SELECT user_id FROM api_key WHERE key_hash = $1 OR key = $2 LIMIT 1',
      [hashed, key]
    )
    rows = result.rows
  } catch (error) {
    const pgError = error as { code?: string }
    if (pgError.code !== '42703') throw error
    const result = await pool.query('SELECT user_id FROM api_key WHERE key = $1 LIMIT 1', [key])
    rows = result.rows
  }

  if (!rows.length) return null

  pool.query(
    'UPDATE api_key SET request_count = request_count + 1, last_used_at = NOW() WHERE key_hash = $1 OR key = $2',
    [hashed, key]
  ).catch(error => {
    const pgError = error as { code?: string }
    if (pgError.code === '42703') {
      pool.query(
        'UPDATE api_key SET request_count = request_count + 1, last_used_at = NOW() WHERE key = $1',
        [key]
      ).catch(console.error)
      return
    }
    console.error(error)
  })

  return rows[0].user_id as string
}

function getKey(req: express.Request): string | null {
  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const header = req.headers['x-api-key']
  if (typeof header === 'string') return header
  return null
}

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/v1/remember', async (req, res) => {
  try {
    const key = getKey(req)
    if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
    const userId = await validateApiKey(key)
    if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

    const { scopeId, event } = req.body
    if (!scopeId || event === undefined) { res.status(400).json({ error: 'scopeId is required' }); return }

    const t0 = Date.now()
    const result = await mem.remember(`${userId}:${scopeId}`, event)
    const latency = Date.now() - t0

    mem.metrics?.record(key, 'remember', latency, 0).catch(console.error)

    res.set('X-Memcone-Latency-Ms', String(latency))
    res.json({
      ok: true,
      extracted: result.stored,
      facts: result.facts,
      contradictions_resolved: result.contradictions_resolved,
      preview: result.facts[0] ?? null,
      latency_ms: latency,
    })
  } catch (error) {
    console.error('[mem.api] /v1/remember failed', error)
    res.status(500).json({ error: errorMessage(error) })
  }
})

app.post('/v1/recall', async (req, res) => {
  try {
    const key = getKey(req)
    if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
    const userId = await validateApiKey(key)
    if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

    const { scopeId, query } = req.body
    if (!scopeId || !query) { res.status(400).json({ error: 'scopeId is required' }); return }

    const t0 = Date.now()
    const result = await mem.recall(`${userId}:${scopeId}`, query)
    const latency = Date.now() - t0

    mem.metrics?.record(key, 'recall', latency, 0).catch(console.error)

    res.set('X-Memcone-Latency-Ms', String(latency))
    res.json({ result })
  } catch (error) {
    console.error('[mem.api] /v1/recall failed', error)
    res.status(500).json({ error: errorMessage(error) })
  }
})

app.post('/v1/context', async (req, res) => {
  try {
    const key = getKey(req)
    if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
    const userId = await validateApiKey(key)
    if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

    const { 
      scopeId, 
      task, 
      mode: bodyMode = 'fast', 
      debug = false,
      token_budget,
      temporal_context,
    } = req.body
    if (!scopeId || !task) { res.status(400).json({ error: 'scopeId is required' }); return }

    const modeQuery = req.query.mode as string | undefined
    const modeHeader = req.headers['x-memcone-mode'] as string | undefined
    const mode = modeQuery ?? modeHeader ?? bodyMode ?? 'fast'

    const debugHeader = req.headers['x-memcone-debug'] === 'true' || debug === true

    const t0 = Date.now()
    const ctxResult = await mem.context(`${userId}:${scopeId}`, task, {
      mode: mode === 'fresh' ? 'fresh' : 'fast',
      debug: debugHeader,
      tokenBudget: typeof token_budget === 'number' ? token_budget : undefined,
      temporalContext: temporal_context === true,
    })
    const latency = Date.now() - t0

    const callType: CallType = mode === 'fresh'
      ? 'context_fresh'
      : ctxResult.cache_hit ? 'context_fast_hit' : 'context_fast_miss'

    mem.metrics?.record(key, callType, latency, ctxResult.tokens_saved).catch(console.error)

    res.set('X-Memcone-Cache', ctxResult.cache_hit ? 'HIT' : 'MISS')
    res.set('X-Memcone-Latency-Ms', String(latency))
    res.set('X-Memcone-Tokens-Saved', String(ctxResult.tokens_saved))

    const body: Record<string, unknown> = {
      result: ctxResult.result,
      tokens_saved: ctxResult.tokens_saved,
      cache_hit: ctxResult.cache_hit,
      query_type: ctxResult.query_type,
    }
    if (debugHeader && ctxResult.sources) body.sources = ctxResult.sources
    res.json(body)
  } catch (error) {
    console.error('[mem.api] /v1/context failed', error)
    res.status(500).json({ error: errorMessage(error) })
  }
})

app.get('/v1/traces', async (req, res) => {
  const key = getKey(req)
  if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
  const userId = await validateApiKey(key)
  if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

  const limit = Math.min(100, parseInt(req.query.limit as string ?? '50', 10) || 50)
  const traces = await mem.store.listAllTraces(userId, limit)
  res.json({ traces })
})

app.get('/v1/scopes', async (req, res) => {
  const key = getKey(req)
  if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
  const userId = await validateApiKey(key)
  if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

  const scopes = await mem.store.listScopes(userId)
  res.json({ scopes })
})

app.get('/v1/scopes/:scopeId/traces', async (req, res) => {
  const key = getKey(req)
  if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
  const userId = await validateApiKey(key)
  if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

  const { scopeId } = req.params
  const limit = Math.min(50, parseInt(req.query.limit as string ?? '20', 10) || 20)
  const traces = await mem.store.listTraces(userId, scopeId, limit)
  res.json({ scopeId, traces })
})

app.get('/v1/scopes/:scopeId/beliefs', async (req, res) => {
  const key = getKey(req)
  if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
  const userId = await validateApiKey(key)
  if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

  const { scopeId } = req.params
  const beliefs = await mem.store.listBeliefs(userId, scopeId)
  res.json({ scopeId, beliefs })
})

app.get('/v1/usage', async (req, res) => {
  const key = getKey(req)
  if (!key) { res.status(401).json({ error: 'Invalid API key' }); return }
  const userId = await validateApiKey(key)
  if (!userId) { res.status(401).json({ error: 'Invalid API key' }); return }

  if (!mem.metrics) {
    res.json({
      units: 0,
      hits: 0,
      misses: 0,
      tokensSaved: 0,
      avgLatencyMs: 0,
      hitRate: 0,
      estimatedBillDollars: 0,
      totalCalls: 0,
      breakdown: {
        contextFastHit: 0,
        contextFastMiss: 0,
        contextFresh: 0,
        remember: 0,
        recall: 0,
      },
    })
    return
  }

  const summary = await mem.metrics.summary(key)
  res.json(summary)
})

const port = process.env.PORT ?? 3000

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!(error instanceof Error)) {
    next(error)
    return
  }

  const bodyError = error as Error & { type?: string; status?: number; statusCode?: number }
  if (bodyError.type === 'entity.too.large' || bodyError.status === 413 || bodyError.statusCode === 413) {
    res.status(413).json({
      error: `Payload too large. Increase JSON_BODY_LIMIT if needed (current ${jsonLimit}).`,
    })
    return
  }

  next(error)
})

app.listen(port, () => {
  console.log(`mem api listening on :${port}`)
})
