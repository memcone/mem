import OpenAI from 'openai'

export interface SemanticLLM {
  embed(text: string): Promise<number[]>
  embedMany(texts: string[]): Promise<number[][]>
  extract(raw: string): Promise<string[]>
  extractEntities(text: string): Promise<string[]>
  compress(memories: string[], query: string): Promise<string>
  formatContext(memories: string[], task: string): Promise<string>
  contradicts(newFact: string, candidates: string[]): Promise<string[]>
}

const ENTITY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'my', 'of', 'on', 'or', 'our', 'that', 'the', 'their', 'them', 'they', 'this',
  'to', 'user', 'was', 'we', 'were', 'what', 'when', 'where', 'who', 'why', 'with',
  'you', 'your',
])

function normalizeEntity(entity: string): string {
  return entity.replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function heuristicEntities(text: string): string[] {
  const found = new Map<string, string>()
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  if (!normalizedText) return []

  const quoted = normalizedText.match(/"([^"]+)"|'([^']+)'/g) ?? []
  for (const match of quoted) {
    const cleaned = normalizeEntity(match.slice(1, -1))
    if (cleaned.length >= 2) found.set(cleaned.toLowerCase(), cleaned)
  }

  const titleCaseMatches = normalizedText.match(/\b(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3})\b/g) ?? []
  for (const match of titleCaseMatches) {
    const cleaned = normalizeEntity(match)
    if (cleaned.length >= 2) found.set(cleaned.toLowerCase(), cleaned)
  }

  const lower = normalizedText.toLowerCase().replace(/[^\w\s-]/g, ' ')
  const tokens = lower.split(/\s+/).filter(Boolean)
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i <= tokens.length - size; i++) {
      const phraseTokens = tokens.slice(i, i + size)
      if (phraseTokens.every(token => ENTITY_STOPWORDS.has(token) || token.length < 3)) continue
      const phrase = phraseTokens.join(' ').trim()
      if (phrase.length < 4) continue
      if (/\b(project|team|company|product|framework|language|database|api|sdk|model|feature|dashboard|theme|layout|workflow)\b/.test(phrase)) {
        found.set(phrase, phrase)
      }
    }
  }

  return Array.from(found.values()).slice(0, 8)
}

export class OpenAISemanticLLM implements SemanticLLM {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    })
    return response.data[0].embedding
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    })
    return response.data.map(item => item.embedding)
  }

  async extract(raw: string): Promise<string[]> {
    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Extract memory-worthy facts from the input. ' +
            'Return discrete, standalone statements that could be queried later. ' +
            'Preserve exact technical details when present: file names, frameworks, packages, APIs, bugs, tasks, decisions, constraints, quoted phrases, project names, and named entities. ' +
            'Keep assistant-confirmed or tool-confirmed facts when they change project or user state. ' +
            'Merge closely related details from the same rule, task, or project state into one fact instead of splitting them into many tiny variants. ' +
            'Do not collapse multiple concrete details into one vague summary if the details could be asked about separately. ' +
            'Avoid producing near-duplicate lines that only differ by minor wording. ' +
            'Ignore pure filler acknowledgements. Return one fact per line. No numbering, no explanation.',
        },
        { role: 'user', content: raw },
      ],
    })
    const content = response.choices[0].message.content ?? ''
    return content
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
  }

  async extractEntities(text: string): Promise<string[]> {
    return heuristicEntities(text)
  }

  async compress(memories: string[], query: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Synthesize the provided memory fragments into a single, coherent, present-tense ' +
            'summary of what is currently true. The query provides context for relevance. ' +
            'If contradictions exist, the most recent signal wins — collapse ambiguity into one clear stance. ' +
            'Never hedge with "mixed feelings" or "sometimes". Always commit to a single belief. ' +
            'Be concise and factual.',
        },
        {
          role: 'user',
          content: `Query: ${query}\n\nMemories:\n${memories.join('\n')}`,
        },
      ],
    })
    return response.choices[0].message.content ?? ''
  }

  async formatContext(memories: string[], task: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Prepare a context block for an AI assistant. Given memory fragments and a task, ' +
            'produce a concise context block the AI can use to personalize its response. ' +
            'If conflicting signals exist, resolve them into a single dominant current stance — do not describe ambiguity or dual states. ' +
            'Write in third person ("The user prefers..."). Be specific and actionable.',
        },
        {
          role: 'user',
          content: `Task: ${task}\n\nMemories:\n${memories.join('\n')}`,
        },
      ],
    })
    return response.choices[0].message.content ?? ''
  }

  async contradicts(newFact: string, candidates: string[]): Promise<string[]> {
    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are given a new belief and a list of existing beliefs. ' +
            'Return only the beliefs that directly contradict the new belief — ' +
            'meaning they cannot both be true simultaneously. ' +
            'Similar, complementary, or merely different beliefs are NOT contradictions. ' +
            'Copy each contradicting belief exactly as written, one per line. ' +
            'If nothing contradicts, return nothing.',
        },
        {
          role: 'user',
          content: `New belief: ${newFact}\n\nExisting beliefs:\n${candidates.join('\n')}`,
        },
      ],
    })
    const content = response.choices[0].message.content ?? ''
    const returned = content
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    // guard: only return exact matches from candidates to prevent hallucinated texts
    return returned.filter(l => candidates.includes(l))
  }
}
