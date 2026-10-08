import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const high = ReasoningEffortId('high')
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8192 }, reasoning: { efforts: [{ id: high, name: 'High' }], defaultEffort: high } })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['actual'], adapter)
  return { ctx, adapter }
}

describe('effective LLM dispatch observation', () => {
  it('captures resolved defaults and the same clean frozen input the adapter sees', async () => {
    const h = await fixture()
    const original = deepFreeze<GenerateOptions>({ provider: 'alias', model: 'alias', messages: [] })
    h.ctx.on('llm/stream', async function* (options, next) {
      if (options.provider === 'alias') yield* this.stream({ ...options, provider: 'actual', model: 'model' })
      else yield* next()
    })
    const observer = vi.fn()
    for await (const _chunk of h.ctx.llm.stream(original, observer)) { /* consume the one terminal chunk */ }
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0]![0]).toBe(h.adapter.calls[0])
    expect(observer.mock.calls[0]![0]).toMatchObject({ provider: 'actual', model: 'model', reasoningEffort: 'high' })
    expect(observer.mock.calls[0]![1]).toMatchObject({ context: { contextWindow: 8192 } })
    expect(Object.getOwnPropertySymbols(h.adapter.calls[0]!)).toEqual([])
    expect(Object.isFrozen(original)).toBe(true)
    expect(original.provider).toBe('alias')
  })

  it('preserves directly frozen dispatch inputs after removing the private observer carrier', async () => {
    const h = await fixture()
    const options = deepFreeze<GenerateOptions>({ provider: 'actual', model: 'model', messages: [] })
    const observer = vi.fn()
    for await (const _chunk of h.ctx.llm.stream(options, observer)) { /* consume the terminal chunk */ }
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0]![0]).toBe(h.adapter.calls[0])
    expect(Object.isFrozen(h.adapter.calls[0])).toBe(true)
    expect(Object.getOwnPropertySymbols(h.adapter.calls[0]!)).toEqual([])
    expect(Object.getOwnPropertySymbols(options)).toEqual([])
  })

  it('uses the same public file handle at bounded preparation and adapter dispatch', async () => {
    const h = await fixture()
    const ref = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), name: 'source.txt', mediaType: 'text/plain', bytes: 2 }
    const expected = h.ctx.llm.fileRequestText(ref)
    for await (const _chunk of h.ctx.llm.stream({
      provider: 'actual', model: 'model',
      messages: [{ role: 'user', content: [{ type: 'file', attachment: ref }] }],
    })) { /* resolve the real request projection */ }
    expect(h.adapter.calls[0]!.messages[0]!.content).toEqual([{ type: 'text', text: expected }])
    expect(expected).toContain('source.txt')
  })

  it('leaves consumer observer failures thrown before constructing the adapter stream', async () => {
    const h = await fixture()
    const error = new Error('observer failed')
    async function consume() {
      for await (const _chunk of h.ctx.llm.stream({ provider: 'actual', model: 'model', messages: [] }, () => { throw error })) { /* no chunks expected */ }
    }
    await expect(consume()).rejects.toBe(error)
    expect(h.adapter.calls).toEqual([])
  })

  it('does not notify when middleware supplies a stream without adapter dispatch', async () => {
    const h = await fixture()
    h.ctx.on('llm/stream', async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const observer = vi.fn()
    for await (const _chunk of h.ctx.llm.stream({ provider: 'actual', model: 'model', messages: [] }, observer)) { /* consume replay */ }
    expect(observer).not.toHaveBeenCalled()
    expect(h.adapter.calls).toEqual([])
  })
})
