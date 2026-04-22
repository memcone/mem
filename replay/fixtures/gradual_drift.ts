import type { ReplayFixture } from '../types'

export const gradualDrift: ReplayFixture = {
  name: 'gradual_drift',
  query: 'UI preference',
  task: 'build settings page',
  events: Array.from({ length: 20 }, (_, i) => {
    const t = i / 20
    const event =
      t < 0.3 ? 'user prefers minimal UI'
      : t < 0.6 ? 'user prefers balanced UI'
      : t < 0.8 ? 'user prefers data-rich UI'
      : 'user strongly prefers dense dashboard-heavy UI'
    return { seq: i + 1, event }
  }),
}
