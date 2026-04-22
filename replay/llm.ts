import type { SemanticLLM } from '../src/llm'

// Explicit opposing pairs — if one term of a pair is in A and the other in B, they contradict
const OPPOSING_PAIRS: Array<[string, string]> = [
  ['likes', 'hates'],
  ['likes', 'dislikes'],
  ['loves', 'hates'],
  ['prefers', 'hates'],
  ['prefers', 'dislikes'],
  ['minimal', 'balanced'],
  ['minimal', 'data-rich'],
  ['minimal', 'dense'],
  ['minimal', 'dashboard'],
  ['balanced', 'data-rich'],
  ['balanced', 'dense'],
  ['balanced', 'dashboard'],
  ['data-rich', 'dense'],
  ['data-rich', 'dashboard'],
  ['dark mode', 'light mode'],
]

function detectContradiction(a: string, b: string): boolean {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return OPPOSING_PAIRS.some(
    ([x, y]) => (la.includes(x) && lb.includes(y)) || (la.includes(y) && lb.includes(x))
  )
}

// Produces a deterministic unit vector from text — same text → same embedding
function deterministicEmbed(text: string): number[] {
  const vec = new Array(1536).fill(0)
  for (let i = 0; i < text.length; i++) {
    vec[i % 1536] += text.charCodeAt(i) / 255
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return vec.map(v => v / (mag || 1))
}

// Returns the top belief text stripped of its strength annotation
function topText(memories: string[]): string {
  return memories[0]?.replace(/ \(strength: [\d.]+\)$/, '') ?? ''
}

export function createDeterministicLLM(): SemanticLLM {
  return {
    embed: text => Promise.resolve(deterministicEmbed(text)),
    embedMany: texts => Promise.resolve(texts.map(deterministicEmbed)),

    // Treat the whole event as a single fact — no extraction noise
    extract: raw => Promise.resolve([raw]),
    extractEntities: () => Promise.resolve([]),

    // Return the highest-strength belief verbatim — pure physics output
    compress: (memories, _query) => Promise.resolve(topText(memories)),

    formatContext: (memories, _task) => Promise.resolve(topText(memories)),

    contradicts: (newFact, candidates) =>
      Promise.resolve(candidates.filter(c => detectContradiction(newFact, c))),
  }
}
