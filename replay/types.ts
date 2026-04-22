import type { BeliefSnapshot } from '../src/engine'

export type ReplayEvent = {
  seq: number
  event: string
}

export type Snapshot = {
  seq: number
  recall: string
  context: string
  topBeliefs: BeliefSnapshot[]
}

export type ReplayFixture = {
  name: string
  query: string
  task: string
  events: ReplayEvent[]
}
