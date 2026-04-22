import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('openai', () => {
  const mockCreate = vi.fn()
  const mockEmbeddingsCreate = vi.fn()
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: { create: mockEmbeddingsCreate },
      chat: { completions: { create: mockCreate } },
    })),
    __mockCreate: mockCreate,
    __mockEmbeddingsCreate: mockEmbeddingsCreate,
  }
})

import { OpenAISemanticLLM } from '../src/llm'
import OpenAI from 'openai'

function getMocks() {
  const instance = (OpenAI as ReturnType<typeof vi.fn>).mock.results[0]?.value
  return {
    chatCreate: instance?.chat.completions.create as ReturnType<typeof vi.fn>,
    embedCreate: instance?.embeddings.create as ReturnType<typeof vi.fn>,
  }
}

describe('OpenAISemanticLLM', () => {
  let llm: OpenAISemanticLLM

  beforeEach(() => {
    vi.clearAllMocks()
    llm = new OpenAISemanticLLM('fake-api-key')
  })

  describe('embed', () => {
    it('returns a number[] of length 1536', async () => {
      const { embedCreate } = getMocks()
      embedCreate.mockResolvedValue({ data: [{ embedding: Array(1536).fill(0.5) }] })

      const result = await llm.embed('test input')

      expect(result).toHaveLength(1536)
      expect(typeof result[0]).toBe('number')
    })

    it('calls text-embedding-3-small model', async () => {
      const { embedCreate } = getMocks()
      embedCreate.mockResolvedValue({ data: [{ embedding: Array(1536).fill(0) }] })

      await llm.embed('hello')

      expect(embedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-small', input: 'hello' })
      )
    })
  })

  describe('embedMany', () => {
    it('batches embeddings in one request', async () => {
      const { embedCreate } = getMocks()
      embedCreate.mockResolvedValue({
        data: [
          { embedding: Array(1536).fill(0.1) },
          { embedding: Array(1536).fill(0.2) },
        ],
      })

      const result = await llm.embedMany(['first', 'second'])

      expect(result).toHaveLength(2)
      expect(embedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-small', input: ['first', 'second'] })
      )
    })
  })

  describe('extract', () => {
    it('returns an array of non-empty fact strings', async () => {
      const { chatCreate } = getMocks()
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: 'user dislikes dashboards\nuser prefers minimal UI' } }],
      })

      const result = await llm.extract('I hate dashboards and want a simple UI')

      expect(result).toEqual(['user dislikes dashboards', 'user prefers minimal UI'])
    })

    it('filters out empty lines', async () => {
      const { chatCreate } = getMocks()
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: 'fact one\n\nfact two\n' } }],
      })

      const result = await llm.extract('some input')

      expect(result).toEqual(['fact one', 'fact two'])
    })
  })

  describe('compress', () => {
    it('returns a single string', async () => {
      const { chatCreate } = getMocks()
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: 'User prefers minimal UI and dislikes dashboards.' } }],
      })

      const result = await llm.compress(
        ['user dislikes dashboards', 'user prefers minimal UI'],
        'UI preferences'
      )

      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('formatContext', () => {
    it('returns a single string', async () => {
      const { chatCreate } = getMocks()
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: 'The user prefers minimal UI. Avoid dashboards.' } }],
      })

      const result = await llm.formatContext(
        ['user prefers minimal UI'],
        'build a settings page'
      )

      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })
  })
})
