import type { ReplayFixture } from '../types'

export const rapidOscillation: ReplayFixture = {
  name: 'rapid_oscillation',
  query: 'dark mode preference',
  task: 'set default theme',
  events: Array.from({ length: 10 }, (_, i) => ({
    seq: i + 1,
    event: i % 2 === 0 ? 'user likes dark mode' : 'user hates dark mode',
  })),
}
