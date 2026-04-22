import Redis from 'ioredis'
import { createHash } from 'crypto'

export interface CachedContext {
  result: string
  tokens_saved: number
}

function normalizeTask(task: string): string {
  return task
    .toLowerCase()
    .trim()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function taskHash(task: string): string {
  return createHash('sha1').update(normalizeTask(task)).digest('hex').slice(0, 16)
}

export class Cache {
  private client: Redis

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false })
  }

  private async version(scopeId: string): Promise<number> {
    const v = await this.client.get(`ver:${scopeId}`)
    return v ? parseInt(v, 10) : 0
  }

  private async key(scopeId: string, task: string): Promise<string> {
    const v = await this.version(scopeId)
    return `ctx:${scopeId}:v${v}:${taskHash(task)}`
  }

  async getContext(scopeId: string, task: string): Promise<CachedContext | null> {
    try {
      const raw = await this.client.get(await this.key(scopeId, task))
      if (!raw) return null
      try { return JSON.parse(raw) as CachedContext } catch { return null }
    } catch (error) {
      console.error('[mem.cache] getContext failed', error)
      return null
    }
  }

  async setContext(scopeId: string, task: string, value: CachedContext, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(await this.key(scopeId, task), JSON.stringify(value), 'EX', ttlSeconds)
    } catch (error) {
      console.error('[mem.cache] setContext failed', error)
    }
  }

  async bumpVersion(scopeId: string): Promise<void> {
    try {
      await this.client.incr(`ver:${scopeId}`)
    } catch (error) {
      console.error('[mem.cache] bumpVersion failed', error)
    }
  }

  async flushTestKeys(): Promise<void> {
    const keys = await this.client.keys('ctx:test-*')
    const vers = await this.client.keys('ver:test-*')
    const scopeA = await this.client.keys('ctx:scope-a*')
    const scopeB = await this.client.keys('ctx:scope-b*')
    const scopeC = await this.client.keys('ctx:scope-c*')
    const verA = await this.client.keys('ver:scope-a*')
    const verB = await this.client.keys('ver:scope-b*')
    const verC = await this.client.keys('ver:scope-c*')
    const all = [...keys, ...vers, ...scopeA, ...scopeB, ...scopeC, ...verA, ...verB, ...verC]
    if (all.length) await this.client.del(...all)
  }

  async close(): Promise<void> {
    await this.client.quit()
  }
}
