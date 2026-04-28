import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Store } from '../src/store'
import { runReplay } from '../replay/runner'
import { createDeterministicLLM } from '../replay/llm'
import { gradualDrift } from '../replay/fixtures/gradual_drift'
import { rapidOscillation } from '../replay/fixtures/rapid_oscillation'
import { lateAmbush } from '../replay/fixtures/late_ambush'
import type { Snapshot } from '../replay/types'

const DB_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/mem_test'

function makeReplayStore() {
  return new Store(DB_URL)
}

// Pinned replay clock — all strength computations use the same now
const REPLAY_NOW = new Date('2026-01-01T00:00:00Z').getTime()

function topBelief(snap: Snapshot): string {
  return snap.topBeliefs[0]?.text ?? ''
}

function retrievedState(snap: Snapshot): string {
  const context = typeof snap.context === 'string' ? snap.context : snap.context.result
  return `${snap.recall}\n${context}`
}

// Find the first seq where the top belief matches a predicate
function firstSwitch(snapshots: Snapshot[], predicate: (text: string) => boolean): number | null {
  const snap = snapshots.find(s => predicate(topBelief(s)))
  return snap?.seq ?? null
}

describe('replay: gradual_drift', () => {
  let snapshots: Snapshot[]
  let store: Store

  beforeAll(async () => {
    store = makeReplayStore()
    const llm = createDeterministicLLM()
    snapshots = await runReplay({
      store,
      llm,
      fixture: gradualDrift,
      scopeId: `replay-drift-${Date.now()}`,
      now: REPLAY_NOW,
    })
  }, 30_000)

  afterAll(async () => { await store.close() })

  it('produces one snapshot per event', () => {
    expect(snapshots).toHaveLength(gradualDrift.events.length)
  })

  it('starts with minimal UI as top belief', () => {
    expect(topBelief(snapshots[0])).toContain('minimal UI')
  })

  it('top belief transitions through the full drift sequence', () => {
    const minimalSeqs = snapshots.filter(s => topBelief(s).includes('minimal')).map(s => s.seq)
    const balancedSeqs = snapshots.filter(s => topBelief(s).includes('balanced')).map(s => s.seq)
    const dataRichSeqs = snapshots.filter(s =>
      topBelief(s).includes('data-rich') || topBelief(s).includes('dense')
    ).map(s => s.seq)

    expect(minimalSeqs.length).toBeGreaterThan(0)
    expect(balancedSeqs.length).toBeGreaterThan(0)
    expect(dataRichSeqs.length).toBeGreaterThan(0)

    // minimal → balanced → data-rich: ordering must hold
    expect(Math.max(...minimalSeqs)).toBeLessThan(Math.min(...balancedSeqs))
    expect(Math.max(...balancedSeqs)).toBeLessThan(Math.min(...dataRichSeqs))
  })

  it('minimal UI phase lasts at least 6 steps before yielding', () => {
    const switchSeq = firstSwitch(snapshots, t => !t.includes('minimal'))
    expect(switchSeq).not.toBeNull()
    expect(switchSeq!).toBeGreaterThan(6)
  })

  it('belief at final step reflects dense/data-rich preference', () => {
    const last = snapshots.at(-1)!
    expect(topBelief(last)).toMatch(/data-rich|dense|dashboard/)
  })

  it('snapshots include topBeliefs with strength and reinforcement_count', () => {
    const mid = snapshots[9]
    expect(mid.topBeliefs.length).toBeGreaterThan(0)
    expect(typeof mid.topBeliefs[0].strength).toBe('number')
    expect(typeof mid.topBeliefs[0].reinforcement_count).toBe('number')
  })
})

describe('replay: rapid_oscillation', () => {
  let snapshots: Snapshot[]
  let store: Store

  beforeAll(async () => {
    store = makeReplayStore()
    const llm = createDeterministicLLM()
    snapshots = await runReplay({
      store,
      llm,
      fixture: rapidOscillation,
      scopeId: `replay-osc-${Date.now()}`,
      now: REPLAY_NOW,
    })
  }, 30_000)

  afterAll(async () => { await store.close() })

  it('produces one snapshot per event', () => {
    expect(snapshots).toHaveLength(rapidOscillation.events.length)
  })

  it('retrieved state tracks most recent event — no deadlock', () => {
    // With seqLag + contradiction decay, the system should follow the most recent signal
    const lastSnap = snapshots.at(-1)!
    // Final event is 'user hates dark mode' (seq=10, even index=9, 9%2=1 → hates)
    expect(retrievedState(lastSnap)).toContain('hates dark mode')
  })

  it('both states appear across snapshots — not permanently locked', () => {
    const hasLikes = snapshots.some(s => retrievedState(s).includes('likes dark mode'))
    const hasHates = snapshots.some(s => retrievedState(s).includes('hates dark mode'))
    expect(hasLikes).toBe(true)
    expect(hasHates).toBe(true)
  })
})

describe('replay: late_ambush', () => {
  let snapshots: Snapshot[]
  let store: Store

  beforeAll(async () => {
    store = makeReplayStore()
    const llm = createDeterministicLLM()
    snapshots = await runReplay({
      store,
      llm,
      fixture: lateAmbush,
      scopeId: `replay-ambush-${Date.now()}`,
      now: REPLAY_NOW,
    })
  }, 30_000)

  afterAll(async () => { await store.close() })

  it('minimal UI holds through all 10 reinforcement steps', () => {
    const minimalPhase = snapshots.slice(0, 10)
    expect(minimalPhase.every(s => topBelief(s).includes('minimal'))).toBe(true)
  })

  it('single ambush event at step 11 does not immediately flip 10x-reinforced belief', () => {
    // Correct behavior: entrenched belief resists a single contradiction
    expect(topBelief(snapshots[10])).toContain('minimal')
  })
})
