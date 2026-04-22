import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Cache } from '../src/cache'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

describe('Cache', () => {
  let cache: Cache

  beforeAll(async () => {
    cache = new Cache(REDIS_URL)
  })

  afterAll(async () => {
    await cache.close()
  })

  beforeEach(async () => {
    await cache.flushTestKeys()
  })

  it('returns null on miss', async () => {
    const hit = await cache.getContext('test-scope-1', 'some task')
    expect(hit).toBeNull()
  })

  it('stores and returns a context payload', async () => {
    await cache.setContext('test-scope-1', 'task-a', { result: 'hello', tokens_saved: 12 }, 300)
    const hit = await cache.getContext('test-scope-1', 'task-a')
    expect(hit).toEqual({ result: 'hello', tokens_saved: 12 })
  })

  it('treats equivalent task wording as the same cache key', async () => {
    await cache.setContext('scope-c', 'Reply to user!!!', { result: 'hello', tokens_saved: 12 }, 300)
    const hit = await cache.getContext('scope-c', '  reply   to user  ')
    expect(hit).toEqual({ result: 'hello', tokens_saved: 12 })
  })

  it('bumpVersion invalidates prior entries', async () => {
    await cache.setContext('test-scope-2', 'task-x', { result: 'v1', tokens_saved: 0 }, 300)
    expect(await cache.getContext('test-scope-2', 'task-x')).toEqual({ result: 'v1', tokens_saved: 0 })
    await cache.bumpVersion('test-scope-2')
    expect(await cache.getContext('test-scope-2', 'task-x')).toBeNull()
  })

  it('different scopes have independent versions', async () => {
    await cache.setContext('scope-a', 't', { result: 'A', tokens_saved: 0 }, 300)
    await cache.setContext('scope-b', 't', { result: 'B', tokens_saved: 0 }, 300)
    await cache.bumpVersion('scope-a')
    expect(await cache.getContext('scope-a', 't')).toBeNull()
    expect(await cache.getContext('scope-b', 't')).toEqual({ result: 'B', tokens_saved: 0 })
  })
})
