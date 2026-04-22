import type { ReplayFixture } from '../types'

export const lateAmbush: ReplayFixture = {
  name: 'late_ambush',
  query: 'UI preference',
  task: 'design interface',
  events: [
    ...Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1,
      event: 'user strongly prefers minimal UI',
    })),
    { seq: 11, event: 'user absolutely hates minimal UI and wants dense dashboards' },
  ],
}
