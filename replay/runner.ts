import type { Store } from '../src/store'
import type { SemanticLLM } from '../src/llm'
import * as engine from '../src/engine'
import type { ReplayFixture, Snapshot } from './types'

export async function runReplay(params: {
  store: Store
  llm: SemanticLLM
  fixture: ReplayFixture
  scopeId?: string
  now?: number
}): Promise<Snapshot[]> {
  const { store, llm, fixture } = params
  const scopeId = params.scopeId ?? `replay-${fixture.name}-${Date.now()}`
  const now = params.now ?? Date.now()

  await store.init()

  const queryEmbedding = await llm.embed(fixture.query)
  const snapshots: Snapshot[] = []

  for (const evt of fixture.events) {
    await engine.remember(store, llm, scopeId, evt.event, evt.seq)

    const [recall, ctx, topBeliefs] = await Promise.all([
      engine.recall(store, llm, scopeId, fixture.query, evt.seq, now),
      engine.context(store, llm, scopeId, fixture.task, evt.seq, now),
      engine.getTopBeliefs(store, scopeId, queryEmbedding, evt.seq, 10, now),
    ])

    snapshots.push({ seq: evt.seq, recall, context: ctx, topBeliefs })
  }

  return snapshots
}
