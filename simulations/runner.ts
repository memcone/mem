import { createMem } from '../src/index'

const mem = createMem({
  db: process.env.DATABASE_URL!,
  llm: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
})

const scenarios: Array<{
  name: string
  query: string
  task: string
  events: string[]
}> = [
  {
    name: 'contradictions',
    query: 'UI preferences',
    task: 'build a UI component',
    events: [
      'user likes dashboards',
      'user hates dashboards',
      'user prefers minimal UI',
      'actually user loves data-rich dashboards',
      'user says never show dashboards again',
    ],
  },
  {
    name: 'long_chain',
    query: 'what does this user care about?',
    task: 'personalize the app experience',
    events: Array.from({ length: 20 }, (_, i) =>
      [
        'user prefers dark mode',
        'user dislikes notification popups',
        'user wants keyboard shortcuts for everything',
        'user prefers compact, dense layouts',
        'user cares a lot about fast load times',
      ][i % 5]
    ),
  },
  {
    name: 'noisy',
    query: 'UI preferences',
    task: 'design a settings page',
    events: [
      'user maybe likes clean UI??',
      'user idk hates clutter I think',
      'lol user prefers simple stuff',
      'the user was like "too many buttons" or something',
      'user said something about minimalism i guess',
    ],
  },

  // --- Phase diagram scenarios ---

  {
    name: 'rapid_oscillation',
    query: 'dark mode preference',
    task: 'set default theme',
    events: Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? 'user likes dark mode' : 'user hates dark mode'
    ),
  },

  {
    name: 'late_ambush',
    query: 'UI preference',
    task: 'design interface',
    events: [
      ...Array(10).fill('user strongly prefers minimal UI'),
      'user absolutely hates minimal UI and wants dense dashboards',
    ],
  },

  {
    name: 'gradual_drift',
    query: 'UI preference',
    task: 'build settings page',
    events: Array.from({ length: 20 }, (_, i) => {
      const t = i / 20
      if (t < 0.3) return 'user prefers minimal UI'
      if (t < 0.6) return 'user prefers balanced UI'
      if (t < 0.8) return 'user prefers data-rich UI'
      return 'user strongly prefers dense dashboard-heavy UI'
    }),
  },
]

function divider(char: string, width = 60) {
  return char.repeat(width)
}

async function run() {
  for (const scenario of scenarios) {
    const scopeId = `sim-${scenario.name}-${Date.now()}`

    console.log(`\n${divider('═')}`)
    console.log(`SCENARIO : ${scenario.name}`)
    console.log(`scope    : ${scopeId}`)
    console.log(`query    : "${scenario.query}"`)
    console.log(`task     : "${scenario.task}"`)
    console.log(divider('═'))

    for (const [i, event] of scenario.events.entries()) {
      await mem.remember(scopeId, event)

      const recall = await mem.recall(scopeId, scenario.query)
      const ctx = await mem.context(scopeId, scenario.task)

      console.log(`\n${divider('─')}`)
      console.log(`Step ${i + 1}/${scenario.events.length}`)
      console.log(`${divider('─')}`)
      console.log(`event  : ${event}`)
      console.log(`recall : ${recall}`)
      console.log(`context: ${ctx}`)
    }

    console.log(`\n${divider('─')}`)
    console.log(`END: ${scenario.name}`)
  }
}

run().catch(console.error)
