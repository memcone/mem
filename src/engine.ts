import type {
  Store,
  MemoryRow,
  MemoryType,
  RetrievedBelief,
  ScratchpadRow,
  TraceLaneCounts,
  TraceMemoryTypeCounts,
  TracePackedSection,
} from './store'
import type { SemanticLLM } from './llm'
import type { Cache } from './cache'
import { countTokens } from './tokens'

export interface ContextOptions {
  cache?: Cache
  mode?: 'fast' | 'fresh'
  debug?: boolean
  cacheTtlSeconds?: number
  tokenBudget?: number
  temporalContext?: boolean
}

export interface ContextResult {
  result: string
  tokens_saved: number
  cache_hit: boolean
  sources?: BeliefSnapshot[]
  query_type?: string
}

export type BeliefSnapshot = {
  text: string
  strength: number
  reinforcement_count: number
  last_touched_seq: number
}

type QueryType = 'state' | 'time' | 'rule' | 'fact' | 'conflict'
type PackedSectionKey = 'rules_preferences' | 'current_state' | 'relevant_events' | 'working_memory'
type Lane = 'event' | 'fact' | 'scratchpad'

type ScoredMemory = {
  row: MemoryRow
  strength: number
  score: number
  lane: Lane
  section: PackedSectionKey
  topic: string | null
  polarity: -1 | 0 | 1
  entityMatches: number
  versionStatus: 'active' | 'historical'
}

type DerivedMemory = {
  text: string
  memoryType: MemoryType
  scratchpadKey: string | null
}

type RetrievalBundle = {
  queryType: QueryType
  rows: MemoryRow[]
  scored: ScoredMemory[]
}

const MAX_EXTRACT_INPUT_TOKENS = 6000
const MAX_FACT_EMBED_TOKENS = 7000

function normalizeEvent(event: string | object): string {
  if (typeof event === 'string') return event
  const candidate = event as Record<string, unknown>
  const textLike = [candidate.text, candidate.content, candidate.message, candidate.event]
    .find(value => typeof value === 'string' && value.trim().length > 0)

  if (typeof textLike === 'string') return textLike

  if (typeof candidate.role === 'string' && typeof candidate.content === 'string') {
    return candidate.content
  }

  return JSON.stringify(event)
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return ''
  if (countTokens(normalized) <= maxTokens) return normalized

  let lo = 0
  let hi = normalized.length
  let best = ''

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = normalizeWhitespace(`${normalized.slice(0, mid).trim()} …`)
    if (countTokens(candidate) <= maxTokens) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return best || normalized.slice(0, Math.min(normalized.length, 2048)).trim()
}

function sanitizeExtractInput(text: string): string {
  return truncateToTokenLimit(text, MAX_EXTRACT_INPUT_TOKENS)
}

function sanitizeFact(text: string): string {
  return truncateToTokenLimit(text, MAX_FACT_EMBED_TOKENS)
}

function stripPrefix(text: string): string {
  return text.replace(/^\[(?:fact|event)\]\s*/i, '').trim()
}

function syntheticScratchpadId(scopeId: string, key: string): string {
  return `scratchpad:${scopeId}:${key}`
}

function isLowSignalTurn(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase()
  if (!normalized) return true
  if (normalized.length > 24) return false
  return /^(ok|okay|kk|sure|nice|cool|great|thanks|thank you|got it|understood|i see|makes sense|sounds good|all good|perfect|hmm|hm|yep|yes|nope|nah)[.!?]*$/.test(normalized)
}

function hasMemorySignal(text: string): boolean {
  const lower = normalizeWhitespace(text).toLowerCase()
  if (!lower) return false

  return /\b(i am|i'm|i was|i have|i had|i need|i want|i wanted|i prefer|i like|i love|i hate|i dislike|i use|i used|i work|i worked|i live|i lived|i moved|i moved to|i changed|i switched|i started|my preference|my project|my stack|my team|my name|my email|my address|my phone|remind me|follow up|todo|to do|need to|must|should|always|never|currently|right now)\b/.test(lower)
}

function isEphemeralQuestion(text: string): boolean {
  const normalized = normalizeWhitespace(text)
  const lower = normalized.toLowerCase()
  if (!lower.endsWith('?')) return false
  if (normalized.length > 80) return false
  if (isEventLike(normalized) || hasMemorySignal(normalized)) return false

  const tokenCount = lower.split(/\s+/).filter(Boolean).length
  if (tokenCount > 14) return false

  return /^(can|could|would|will|do|does|did|is|are|should|what|where|when|why|how)\b/.test(lower)
}

function shouldSkipRemember(text: string): boolean {
  return isLowSignalTurn(text) || isEphemeralQuestion(text)
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'that', 'the', 'their',
  'them', 'they', 'this', 'to', 'user', 'was', 'we', 'were', 'what', 'when', 'where',
  'who', 'why', 'with', 'would', 'you', 'your',
])

function keywordTokens(text: string): Set<string> {
  return new Set(
    stripPrefix(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 3 && !STOPWORDS.has(token))
  )
}

function keywordOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0
  const memoryTokens = keywordTokens(text)
  if (memoryTokens.size === 0) return 0

  let matches = 0
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) matches += 1
  }
  return matches / queryTokens.size
}

function isEventLike(text: string): boolean {
  const lower = stripPrefix(text).toLowerCase()
  return /\b(today|yesterday|tomorrow|before|after|first|last|earlier|later|when|then|started|stopped|moved|changed|switched|installed|built|finished|went|migrated|became)\b/.test(lower)
}

function stateKeyForFact(text: string): string | null {
  const lower = stripPrefix(text).toLowerCase()
  const { topic } = polarityAndTopic(text)

  if (/\bapi key\b/.test(lower)) return 'state:api_key'
  if (/\bhomepage route\b/.test(lower)) return 'state:flask_routes'
  if (/\bflask route|routes\b/.test(lower)) return 'state:flask_routes'
  if (/\bhttp requests?\b/.test(lower) && /\bflask\b/.test(lower)) return 'state:flask_routes'
  if (topic) return `state:${topic}`
  if (/\bmust|should|never|always|rule|policy|constraint|allowed|avoid\b/.test(lower)) return 'state:instruction'
  if (/\bneed to|todo|follow up|pending|open loop|remind\b/.test(lower)) return `state:open_loop:${normalizeWhitespace(lower).slice(0, 32)}`

  if (/\b(?:live|lives|living|located|based|moved)\b/.test(lower)) return 'state:location'
  if (/\b(?:working on|building|project|task|migration|launch)\b/.test(lower)) return 'state:project'
  if (/\b(?:use|uses|using|stack|framework|database|language)\b/.test(lower)) return 'state:stack'
  return 'state:general'
}

function deriveMemory(text: string): DerivedMemory {
  if (text.startsWith('[event]') || isEventLike(text)) {
    return { text, memoryType: 'event', scratchpadKey: null }
  }
  return {
    text,
    memoryType: 'state',
    scratchpadKey: stateKeyForFact(text),
  }
}

function deriveMemories(raw: string, extractedFacts: string[]): DerivedMemory[] {
  const syntheticFacts = isEventLike(raw) ? [`[event] ${sanitizeFact(raw)}`] : []
  const facts = Array.from(new Set([
    ...syntheticFacts,
    ...extractedFacts.map(fact => `[fact] ${sanitizeFact(fact)}`),
  ]))
  return facts.map(deriveMemory)
}

function scratchpadRowsToMemories(scopeId: string, rows: ScratchpadRow[]): MemoryRow[] {
  return rows.map(row => ({
    id: syntheticScratchpadId(scopeId, row.key),
    text: `[scratchpad] ${row.text}`,
    memory_type: 'summary',
    scratchpad_key: row.key,
    superseded_by: null,
    reinforcement_count: 5,
    last_touched_seq: row.updated_seq,
    created_at: row.updated_at,
    similarity: 0.96,
  }))
}

function polarityAndTopic(text: string): { polarity: -1 | 0 | 1; topic: string | null } {
  const lower = stripPrefix(text).toLowerCase()

  const patterns: Array<{ regex: RegExp; polarity: -1 | 1 }> = [
    { regex: /\b(?:really |strongly |absolutely )?(?:like|likes|love|loves|prefer|prefers|want|wants|use|uses)\b/g, polarity: 1 },
    { regex: /\b(?:really |strongly |absolutely )?(?:hate|hates|dislike|dislikes|avoid|avoids)\b/g, polarity: -1 },
    { regex: /\bnever\b/g, polarity: -1 },
  ]

  for (const { regex, polarity } of patterns) {
    if (!regex.test(lower)) continue

    const topic = normalizeWhitespace(
      lower
        .replace(/\b(?:user|the user|they|we)\b/g, ' ')
        .replace(/\b(?:really|strongly|absolutely|actually|currently|now)\b/g, ' ')
        .replace(/\b(?:like|likes|love|loves|prefer|prefers|want|wants|use|uses|hate|hates|dislike|dislikes|avoid|avoids|never)\b/g, ' ')
        .replace(/\b(?:to|for|the|a|an|is|are|with|more|less|again)\b/g, ' ')
        .replace(/[^\w\s]/g, ' ')
    )

    return { polarity, topic: topic.length >= 3 ? topic : null }
  }

  return { polarity: 0, topic: null }
}

function contradictionPenalty(candidate: MemoryRow, rows: MemoryRow[]): number {
  const current = polarityAndTopic(candidate.text)
  if (current.polarity === 0 || current.topic === null) return 0

  const hasNewerOpposite = rows.some(other => {
    if (other.id === candidate.id) return false
    const alt = polarityAndTopic(other.text)
    if (alt.topic === null || alt.polarity === 0) return false
    return (
      alt.topic === current.topic &&
      alt.polarity === current.polarity * -1 &&
      other.last_touched_seq > candidate.last_touched_seq
    )
  })

  return hasNewerOpposite ? 0.45 : 0
}

function recencyScore(row: MemoryRow, currentSeq: number): number {
  const seqLag = Math.max(0, currentSeq - row.last_touched_seq)
  return 1 / (1 + seqLag * 0.18)
}

function temporalSignalScore(queryText: string, row: MemoryRow, queryType: QueryType, currentSeq: number): number {
  if (queryType !== 'time') return 0
  const query = queryText.toLowerCase()
  const text = stripPrefix(row.text).toLowerCase()

  let score = 0
  if (row.memory_type === 'event') score += 0.2
  if (/\bafter\b/.test(query) && /\bafter|later|then\b/.test(text)) score += 0.18
  if (/\bbefore\b/.test(query) && /\bbefore|earlier|first\b/.test(text)) score += 0.18
  if (/\bfirst\b/.test(query) && /\bfirst|initially|started\b/.test(text)) score += 0.12
  if (/\blast|latest|current|now|currently\b/.test(query)) score += recencyScore(row, currentSeq) * 0.18
  return Math.min(0.45, score)
}

function contradictionTopic(text: string): { polarity: -1 | 0 | 1; topic: string | null } {
  return polarityAndTopic(text)
}

function likelyContradictions(fact: string, candidates: MemoryRow[]): string[] {
  const current = contradictionTopic(fact)
  if (current.polarity === 0 || current.topic === null) return []

  return candidates
    .filter(candidate => {
      const other = contradictionTopic(candidate.text)
      return (
        other.topic !== null &&
        other.polarity !== 0 &&
        other.topic === current.topic &&
        other.polarity === current.polarity * -1
      )
    })
    .map(candidate => candidate.text)
}

export function computeStrength(row: MemoryRow, currentSeq: number, now: number): number {
  const daysElapsed = Math.max(0, (now - new Date(row.created_at).getTime()) / 86_400_000)
  const seqLag = currentSeq - row.last_touched_seq
  return row.reinforcement_count / ((1 + daysElapsed) * (1 + seqLag * 0.1))
}

function classifyQueryType(task: string): QueryType {
  const lower = task.toLowerCase()
  if (/\b(contradict|contradiction|clarify|which statement|which is correct|change(?:d)? my mind|used to|but now|earlier you said|later you said|have i|did i|do i|am i)\b/.test(lower)) return 'conflict'
  if (/\b(before|after|first|last|earlier|later|when|timeline|order|now|currently|current|recent|latest|today|yesterday|tomorrow)\b/.test(lower)) return 'time'
  if (/\bmust|should|never|always|rule|policy|constraint|allowed\b/.test(lower)) return 'rule'
  if (/\b(theme|dark mode|light mode|ui preference|design preference|prefer|preference|likes?|dislikes?|favorite|favourite|wants?)\b/.test(lower)) return 'state'
  return 'fact'
}

function detectLane(text: string): Lane {
  const lower = stripPrefix(text).toLowerCase()
  if (text.startsWith('[event]') || /\b(today|yesterday|tomorrow|before|after|first|last|installed|built|changed|moved|went|started|finished)\b/.test(lower)) {
    return 'event'
  }
  if (text.startsWith('[scratchpad]') || /\bsummary|working state|in progress|next step|current task\b/.test(lower)) {
    return 'scratchpad'
  }
  return 'fact'
}

function detectSection(row: MemoryRow, lane: Lane, queryType: QueryType): PackedSectionKey {
  if (lane === 'scratchpad') return 'current_state'

  const text = row.text
  const lower = stripPrefix(text).toLowerCase()
  if (queryType === 'time' || queryType === 'conflict' || lane === 'event') {
    return 'relevant_events'
  }
  if (queryType === 'rule' || /\bprefer|likes?|dislikes?|favorite|favourite|wants?|always|never|must|should|rule|policy|constraint\b/.test(lower)) {
    return 'rules_preferences'
  }
  if (row.memory_type === 'state' || /\bin progress|current|open|todo|next|pending|working on|building\b/.test(lower)) {
    return 'current_state'
  }
  return 'working_memory'
}

function strengthWeight(strength: number): number {
  return strength / (1 + Math.max(0, strength))
}

function baseTypePriority(row: MemoryRow, lane: Lane, queryType: QueryType): number {
  if (lane === 'scratchpad') return 0.22
  if (row.memory_type === 'summary') return 0.14
  if (queryType === 'time' && row.memory_type === 'event') return 0.18
  if (queryType === 'conflict' && row.memory_type === 'state') return 0.18
  if ((queryType === 'state' || queryType === 'rule' || queryType === 'fact') && row.memory_type === 'state') return 0.12
  return 0
}

function mergeRows(primary: MemoryRow[], secondary: MemoryRow[]): MemoryRow[] {
  const merged = new Map<string, MemoryRow>()
  for (const row of [...primary, ...secondary]) {
    const existing = merged.get(row.id)
    if (!existing) {
      merged.set(row.id, row)
      continue
    }
    merged.set(row.id, {
      ...existing,
      ...row,
      similarity: Math.max(existing.similarity ?? 0, row.similarity ?? 0),
      entity_matches: Math.max(existing.entity_matches ?? 0, row.entity_matches ?? 0),
    })
  }
  return Array.from(merged.values())
}

function scoreMemories(
  rows: MemoryRow[],
  queryText: string,
  queryType: QueryType,
  currentSeq: number,
  now: number
): ScoredMemory[] {
  const queryTokens = keywordTokens(queryText)
  return rows
    .map(row => {
      const strength = computeStrength(row, currentSeq, now)
      const lane = detectLane(row.text)
      const section = detectSection(row, lane, queryType)
      const { topic, polarity } = polarityAndTopic(row.text)
      const similarity = row.similarity ?? 0
      const entityMatches = row.entity_matches ?? 0
      const entityBoost = entityMatches > 0 ? Math.min(1, entityMatches / 3) : 0
      const lexicalOverlap = keywordOverlap(queryTokens, row.text)
      const recency = recencyScore(row, currentSeq)
      const temporalSignal = temporalSignalScore(queryText, row, queryType, currentSeq)
      const penalty = contradictionPenalty(row, rows)
      const versionStatus = row.superseded_by ? 'historical' : 'active'
      const conflictBoost =
        queryType === 'conflict'
          ? (
            (topic !== null ? 0.08 : 0) +
            (polarity !== 0 ? 0.08 : 0) +
            (versionStatus === 'historical' ? 0.1 : 0)
          )
          : 0
      const activeBias = queryType === 'conflict' && versionStatus === 'active' ? 0.06 : 0
      const score =
        similarity * (queryType === 'conflict' ? 0.24 : queryType === 'fact' ? 0.44 : 0.38) +
        lexicalOverlap * (queryType === 'conflict' ? 0.24 : 0.14) +
        entityBoost * (queryType === 'fact' ? 0.18 : 0.16) +
        strengthWeight(strength) * (queryType === 'time' ? 0.04 : 0.1) +
        recency * (queryType === 'time' ? 0.16 : queryType === 'conflict' ? 0.1 : 0.08) +
        temporalSignal +
        baseTypePriority(row, lane, queryType) +
        conflictBoost +
        activeBias +
        (polarity !== 0 && (queryType === 'state' || queryType === 'rule' || queryType === 'conflict') ? 0.03 : 0) -
        (queryType === 'conflict' ? penalty * 0.15 : penalty)

      return { row, strength, score, lane, section, topic, polarity, entityMatches, versionStatus: versionStatus as 'active' | 'historical' }
    })
    .sort((a, b) => b.score - a.score)
}

function summarizeLaneCounts(items: Array<{ lane: Lane }>): TraceLaneCounts {
  const counts: TraceLaneCounts = { total: items.length, beliefs: 0, events: 0, facts: 0, links: 0, scratchpad: 0 }
  for (const item of items) {
    if (item.lane === 'event') counts.events = (counts.events ?? 0) + 1
    else if (item.lane === 'scratchpad') counts.scratchpad = (counts.scratchpad ?? 0) + 1
    else if (item.lane === 'fact') counts.facts = (counts.facts ?? 0) + 1
    else counts.beliefs = (counts.beliefs ?? 0) + 1
  }
  return counts
}

function summarizeMemoryTypeCounts(items: Array<{ row: MemoryRow; lane: Lane }>): TraceMemoryTypeCounts {
  const counts: TraceMemoryTypeCounts = {}
  for (const item of items) {
    const key = item.lane === 'scratchpad' ? 'scratchpad' : (item.row.memory_type ?? 'state')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function retrievalMetadata(scored: ScoredMemory[], selected: ScoredMemory[]) {
  return {
    candidates: summarizeLaneCounts(scored),
    selected: summarizeLaneCounts(selected),
    candidate_memory_types: summarizeMemoryTypeCounts(scored),
    selected_memory_types: summarizeMemoryTypeCounts(selected),
  }
}

async function expandTemporalContext(
  store: Store,
  scored: ScoredMemory[],
  scopeId: string,
  queryType: QueryType,
  currentSeq: number,
  now: number
): Promise<ScoredMemory[]> {
  const expanded = [...scored]
  const anchors = scored.filter(item => item.lane === 'event').slice(0, 3)

  for (const item of anchors) {
    const neighbors = await store.getSeqRange(scopeId, item.row.last_touched_seq, 2)
    for (const row of neighbors) {
      if (expanded.some(candidate => candidate.row.id === row.id)) continue
      const strength = computeStrength(row, currentSeq, now)
      const lane = detectLane(row.text)
      expanded.push({
        row,
        strength,
        score: item.score * 0.9,
        lane,
        section: detectSection(row, lane, queryType),
        topic: null,
        polarity: 0,
        entityMatches: row.entity_matches ?? 0,
        versionStatus: row.superseded_by ? 'historical' : 'active',
      })
    }
  }

  expanded.sort((a, b) => b.score - a.score)
  return expanded
}

function overlapRatio(a: ScoredMemory, b: ScoredMemory): number {
  if (a.topic && b.topic && a.topic === b.topic) return 1
  const left = keywordTokens(a.row.text)
  const right = keywordTokens(b.row.text)
  if (left.size === 0 || right.size === 0) return 0
  let matches = 0
  for (const token of left) {
    if (right.has(token)) matches += 1
  }
  return matches / Math.max(left.size, right.size)
}

function pickWithinBudget(scored: ScoredMemory[], tokenBudget: number, queryType: QueryType): { selected: ScoredMemory[]; dropped: number } {
  const selected: ScoredMemory[] = []
  let used = 0
  const topicVersions = new Map<string, Set<'active' | 'historical'>>()
  const topicPolarities = new Map<string, -1 | 0 | 1>()

  while (true) {
    let best: ScoredMemory | null = null
    let bestMmr = Number.NEGATIVE_INFINITY

    for (const item of scored) {
      if (selected.some(current => current.row.id === item.row.id)) continue
      const itemTokens = countTokens(item.row.text)
      if (selected.length > 0 && used + itemTokens > tokenBudget) continue

      if (item.topic) {
        const seen = topicVersions.get(item.topic)
        if (queryType !== 'conflict' && seen && seen.has('active') && item.versionStatus === 'historical') continue
        if (queryType !== 'conflict' && seen && seen.has('historical') && item.versionStatus === 'historical') continue
        const seenPolarity = topicPolarities.get(item.topic)
        if (queryType !== 'conflict' && item.polarity !== 0 && seenPolarity !== undefined && seenPolarity !== item.polarity) continue
      }

      const noveltyPenalty = selected.length === 0
        ? 0
        : Math.max(...selected.map(current => overlapRatio(item, current)))
      const mmr = item.score - noveltyPenalty * 0.28
      if (mmr > bestMmr) {
        bestMmr = mmr
        best = item
      }
    }

    if (!best) break
    selected.push(best)
    used += countTokens(best.row.text)

    if (best.topic) {
      const seen = topicVersions.get(best.topic) ?? new Set<'active' | 'historical'>()
      seen.add(best.versionStatus)
      topicVersions.set(best.topic, seen)
      if (best.polarity !== 0) topicPolarities.set(best.topic, best.polarity)
    }
  }

  return { selected, dropped: Math.max(0, scored.length - selected.length) }
}

function buildPackedSections(selected: ScoredMemory[]): TracePackedSection[] {
  const labels: Record<PackedSectionKey, string> = {
    rules_preferences: 'Rules & Preferences',
    current_state: 'Current State',
    relevant_events: 'Relevant Events',
    working_memory: 'Working Memory',
  }

  const sections: TracePackedSection[] = []

  for (const section of Object.keys(labels) as PackedSectionKey[]) {
    const items = selected.filter(item => item.section === section)
    if (items.length === 0) continue
    sections.push({
      key: section,
      label: labels[section],
      item_count: items.length,
      token_estimate: items.reduce((sum, item) => sum + countTokens(item.row.text), 0),
    })
  }

  return sections
}

function buildContextBlock(selected: ScoredMemory[], queryType: QueryType): string {
  const labels: Record<PackedSectionKey, string> = {
    rules_preferences: 'Rules & Preferences',
    current_state: 'Current State',
    relevant_events: 'Relevant Events',
    working_memory: 'Working Memory',
  }

  const parts: string[] = []

  for (const section of Object.keys(labels) as PackedSectionKey[]) {
    const items = selected.filter(item => item.section === section)
    if (items.length === 0) continue

    parts.push(`## ${labels[section]}`)
    for (const item of items) {
      const text = stripPrefix(item.row.text)
      const versionLabel = queryType === 'conflict'
        ? item.versionStatus === 'historical' ? '[historical] ' : '[current] '
        : ''
      if (item.lane === 'event') {
        parts.push(`- ${versionLabel}[seq ${item.row.last_touched_seq}] ${text}`)
      } else {
        parts.push(`- ${versionLabel}${text}`)
      }
    }
    parts.push('')
  }

  return parts.join('\n').trim()
}

function toRetrievedBeliefs(selected: ScoredMemory[]): RetrievedBelief[] {
  return selected.map((item, index) => ({
    id: item.row.id,
    text: stripPrefix(item.row.text),
    strength: item.strength,
    similarity: item.row.similarity ?? 0,
    lane: item.lane,
    reason: item.section.replace(/_/g, ' '),
    source: item.row.memory_type ?? (item.lane === 'scratchpad' ? 'scratchpad' : 'fact'),
    rank: index + 1,
  }))
}

async function persistDerivedMemories(
  store: Store,
  llm: SemanticLLM,
  scopeId: string,
  derived: DerivedMemory[],
  seq: number
): Promise<{ facts: string[]; contradictionsResolved: number }> {
  const facts = derived.map(item => item.text)
  if (facts.length === 0) return { facts: [], contradictionsResolved: 0 }

  const metadata = derived.map(item => ({
    memoryType: item.memoryType,
    scratchpadKey: item.scratchpadKey,
  }))
  const embeddings = await llm.embedMany(facts)
  const memoryIds = await store.insert(scopeId, facts, embeddings, seq, metadata)

  await Promise.all(facts.map(async (fact, index) => {
    const entities = await llm.extractEntities(stripPrefix(fact))
    await store.upsertEntities(scopeId, memoryIds[index], entities)
  }))

  await Promise.all(derived.map(async (item, index) => {
    if (!item.scratchpadKey) return
    await store.upsertScratchpad(scopeId, item.scratchpadKey, stripPrefix(item.text), memoryIds[index], seq)
  }))

  const contradictionCounts = await Promise.all(derived.map(async (item, index) => {
    if (item.memoryType !== 'state') return 0

    const current = contradictionTopic(item.text)
    if (current.polarity === 0 || current.topic === null) return 0

    const nearby = await store.search(scopeId, embeddings[index], 10)
    const candidates = nearby
      .filter(row => row.text !== item.text && (row.similarity ?? 1) >= 0.82)
      .slice(0, 5)
    if (candidates.length === 0) return 0

    let conflicting = likelyContradictions(item.text, candidates)
    if (conflicting.length === 0) {
      conflicting = await llm.contradicts(item.text, candidates.map(row => row.text))
    }
    if (conflicting.length === 0) return 0

    const conflictIds = candidates.filter(row => conflicting.includes(row.text)).map(row => row.id)
    await store.markSuperseded(scopeId, conflictIds, memoryIds[index])
    await store.decay(conflictIds, 1)
    return conflictIds.length
  }))

  return {
    facts,
    contradictionsResolved: contradictionCounts.reduce((sum, count) => sum + count, 0),
  }
}

async function loadRankedMemories(
  store: Store,
  llm: SemanticLLM,
  scopeId: string,
  queryText: string,
  currentSeq: number,
  now: number
): Promise<RetrievalBundle> {
  const queryType = classifyQueryType(queryText)
  const queryEmbedding = await llm.embed(queryText)
  const queryEntities = await llm.extractEntities(queryText)
  const [semanticRows, entityRows, scratchpad] = await Promise.all([
    store.search(scopeId, queryEmbedding, 20),
    store.searchByEntityMatches(scopeId, queryEntities, 12),
    store.getScratchpad(scopeId),
  ])
  const rows = mergeRows(
    mergeRows(semanticRows, entityRows),
    scratchpadRowsToMemories(scopeId, scratchpad)
  )
  const versionKeys = queryType === 'conflict'
    ? Array.from(new Set([
      ...rows
        .filter(row => row.scratchpad_key && row.memory_type === 'state')
        .slice(0, 6)
        .map(row => row.scratchpad_key!),
      ...scratchpad
        .map(row => ({ key: row.key, overlap: keywordOverlap(keywordTokens(queryText), row.text) }))
        .filter(row => row.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 6)
        .map(row => row.key),
    ]))
    : []
  const versionRows = versionKeys.length > 0
    ? await Promise.all(versionKeys.map(key => store.getTopicVersions(scopeId, key, 6)))
    : []
  const mergedRows = versionRows.length > 0
    ? mergeRows(rows, versionRows.flat())
    : rows

  return {
    queryType,
    rows: mergedRows,
    scored: scoreMemories(mergedRows, queryText, queryType, currentSeq, now),
  }
}

export interface RememberOptions {
  cache?: Cache
}

export interface RememberResult {
  facts: string[]
  stored: number
  contradictions_resolved: number
}

export async function remember(
  store: Store,
  llm: SemanticLLM,
  scopeId: string,
  event: string | object,
  seq: number,
  options: RememberOptions = {}
): Promise<RememberResult> {
  const { cache } = options
  const raw = normalizeEvent(event)
  if (!isEventLike(raw) && shouldSkipRemember(raw)) {
    return { facts: [], stored: 0, contradictions_resolved: 0 }
  }
  const extractInput = sanitizeExtractInput(raw)
  const extractedFacts = Array.from(new Set((await llm.extract(extractInput)).map(fact => sanitizeFact(fact)).filter(Boolean)))
  const derived = deriveMemories(raw, extractedFacts)
  const { facts, contradictionsResolved } = await persistDerivedMemories(store, llm, scopeId, derived, seq)

  if (cache && (facts.length > 0 || contradictionsResolved > 0)) {
    cache.bumpVersion(scopeId).catch(console.error)
  }
  return { facts, stored: facts.length, contradictions_resolved: contradictionsResolved }
}

export async function recall(
  store: Store,
  llm: SemanticLLM,
  scopeId: string,
  query: string,
  currentSeq: number,
  now = Date.now()
): Promise<string> {
  const { queryType, rows, scored } = await loadRankedMemories(store, llm, scopeId, query, currentSeq, now)
  if (rows.length === 0) return ''
  const selected = scored.slice(0, 8)
  const retrieved = toRetrievedBeliefs(selected)

  store.logRetrieval(scopeId, 'recall', query, false, retrieved, {
    query_type: queryType,
    ...retrievalMetadata(scored, selected),
    budget: {
      full_replay_tokens: rows.reduce((sum, row) => sum + countTokens(row.text), 0),
      selected_tokens: selected.reduce((sum, item) => sum + countTokens(item.row.text), 0),
    },
    packed_sections: buildPackedSections(selected),
    debug: {
      strategy: 'deterministic_ranked_recall',
      reranked: true,
      dropped_for_budget: Math.max(0, scored.length - selected.length),
    },
  }).catch(console.error)

  return retrieved.map(item => item.text).join('\n')
}

export async function context(
  store: Store,
  llm: SemanticLLM,
  scopeId: string,
  task: string,
  currentSeq: number,
  now = Date.now(),
  options: ContextOptions = {}
): Promise<ContextResult> {
  const { cache, mode = 'fast', debug = false, cacheTtlSeconds = 300 } = options
  const queryType = classifyQueryType(task)

  if (cache && mode === 'fast') {
    const hit = await cache.getContext(scopeId, task)
    if (hit) {
      store.logRetrieval(scopeId, 'context', task, true, [], {
        query_type: queryType,
        budget: {
          context_tokens: countTokens(hit.result),
          saved_tokens: hit.tokens_saved,
        },
        debug: {
          strategy: 'context_cache_hit',
        },
      }).catch(console.error)
      const sources = debug ? await getTopBeliefs(store, scopeId, await llm.embed(task), currentSeq, 10, now) : undefined
      return { result: hit.result, tokens_saved: hit.tokens_saved, cache_hit: true, sources, query_type: queryType }
    }
  }

  const { rows, scored } = await loadRankedMemories(store, llm, scopeId, task, currentSeq, now)
  if (rows.length === 0) return { result: '', tokens_saved: 0, cache_hit: false, query_type: queryType }

  const finalScored = options.temporalContext
    ? await expandTemporalContext(store, scored, scopeId, queryType, currentSeq, now)
    : scored

  const budget = options.tokenBudget ?? 220
  const { selected, dropped } = pickWithinBudget(finalScored, budget, queryType)
  const result = buildContextBlock(selected, queryType)
  const fullReplayTokens = rows.reduce((sum, row) => sum + countTokens(row.text), 0)
  const selectedTokens = selected.reduce((sum, item) => sum + countTokens(item.row.text), 0)
  const contextTokens = countTokens(result)
  const tokensSaved = Math.max(0, fullReplayTokens - contextTokens)
  const packedSections = buildPackedSections(selected)
  const retrieved = toRetrievedBeliefs(selected)

  store.logRetrieval(scopeId, 'context', task, false, retrieved, {
    query_type: queryType,
    ...retrievalMetadata(scored, selected),
    budget: {
      full_replay_tokens: fullReplayTokens,
      selected_tokens: selectedTokens,
      context_tokens: contextTokens,
      saved_tokens: tokensSaved,
    },
    packed_sections: packedSections,
    debug: {
      strategy: 'deterministic_ranked_context',
      reranked: true,
      dropped_for_budget: dropped,
    },
  }).catch(console.error)

  if (cache && mode !== 'fresh') {
    cache.setContext(scopeId, task, { result, tokens_saved: tokensSaved }, cacheTtlSeconds).catch(console.error)
  }

  const sources = debug
    ? rows.map(row => ({ text: row.text, strength: computeStrength(row, currentSeq, now), reinforcement_count: row.reinforcement_count, last_touched_seq: row.last_touched_seq })).sort((a, b) => b.strength - a.strength)
    : undefined

  return { result, tokens_saved: tokensSaved, cache_hit: false, sources, query_type: queryType }
}

export async function getTopBeliefs(
  store: Store,
  scopeId: string,
  queryEmbedding: number[],
  currentSeq: number,
  limit = 10,
  now = Date.now()
): Promise<BeliefSnapshot[]> {
  const rows = await store.search(scopeId, queryEmbedding, limit)
  return rows
    .map(row => ({
      text: row.text,
      strength: computeStrength(row, currentSeq, now),
      reinforcement_count: row.reinforcement_count,
      last_touched_seq: row.last_touched_seq,
    }))
    .sort((a, b) => b.strength - a.strength)
}
