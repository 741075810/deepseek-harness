import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { resolveConfig, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import LlmRuntime, { LlmAdapter, CONTEXT_WINDOW_EXCEEDED_CODE, createMessage, createToolResultMessage, createUserMessage, ToolCallId, ReasoningEffortId, offloadedImageText } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { deriveReplayScript } from '@deepseek-ai/dsh-llm-replay'
import type { Agent } from '@deepseek-ai/dsh-agent'
declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'summary-test-extension': { type: 'summary-test-extension'; text: string }
  }
}


const contexts: Context[] = []
const DATA_PREFIX = 'Ordered conversation/checkpoint data:\n'
const OVERFLOW: FinishReason = {
  kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'request exceeds actual capacity' },
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class BudgetAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  finishFor: (options: GenerateOptions, count: number) => FinishReason = options =>
    this.window !== undefined && byteSize(options) + (options.maxTokens ?? 0) > this.window
      ? OVERFLOW : { kind: 'stop' }
  textFor: (options: GenerateOptions, count: number) => string = (_options, count) => `checkpoint ${count}`

  constructor(readonly window: number | undefined = 8192) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...this.window === undefined ? {} : { context: { contextWindow: this.window } },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const finish = this.finishFor(options, this.calls.length)
    if (finish.kind !== 'error' && finish.kind !== 'aborted') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: this.textFor(options, this.calls.length) }
    }
    yield { type: 'finish', reason: finish }
  }
}

class ExposedEngine extends BasicCompactionEngine {
  run(input: SummarizationInput, owner: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    return this.summarize(input, owner, signal)
  }
}

function source(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function fixtureSession(text: string): Session {
  const session = Session.create(SessionId('bounded-summary-fixture'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', source(text), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'conversation', model: 'large' } }, reason: 'initial',
  })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'previous answer' }],
      source: { kind: 'model', provider: 'conversation', model: 'large' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return session
}

async function harness(window: number | undefined = 8192, config: BasicCompactionConfig = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  void new TokenMeter(ctx)
  const adapter = new BudgetAdapter(window)
  ctx.llm.registerAdapter(['summary'], adapter)
  ctx.llm.registerAdapter(['conversation'], new BudgetAdapter(131_072))
  const engine = new ExposedEngine(ctx, {
    auto: false, maxTokens: 256,
    summarizationProvider: 'summary', summarizationModel: 'small', ...config,
  })
  const session = fixtureSession('data '.repeat(12_000))
  const owner = { session, options: { provider: 'conversation', model: 'large' } } as Agent
  return { ctx, adapter, engine, session, owner }
}

function fragment(options: GenerateOptions): string {
  const block = options.messages[0]?.content[0]
  return block?.type === 'text' && block.text.startsWith(DATA_PREFIX) ? block.text.slice(DATA_PREFIX.length) : ''
}

function byteSize(options: GenerateOptions): number {
  const { signal: _signal, ...request } = options
  return Buffer.byteLength(JSON.stringify(request), 'utf8')
}

async function replace(h: Awaited<ReturnType<typeof harness>>, signal?: AbortSignal) {
  const nodes = h.session.surface.nodes
  return h.engine.compactRegion(nodes[0]!, nodes[1]!, h.owner, signal)
}

describe('bounded compaction summary recovery', () => {
  it('keeps one cache-reusing request when the complete prefix fits', async () => {
    const h = await harness(131_072)
    const input = { messages: [source('short history')], tools: [{ name: 'read', description: 'read', parameters: {} }] }
    const result = await h.engine.run(input, h.owner)
    expect(result.llmStreamCall).toBe(true)
    expect(result).not.toHaveProperty('llmCalls')
    expect(h.adapter.calls).toHaveLength(1)
    expect(h.adapter.calls[0]?.messages.slice(0, -1)).toEqual(input.messages)
    expect(h.adapter.calls[0]?.tools).toEqual(input.tools)
    expect(h.adapter.calls[0]).not.toHaveProperty('system')
  })

  it('prices the smaller configured summary model and merges bounded calls', async () => {
    const h = await harness()
    const result = await h.engine.run({ messages: [source('x'.repeat(100_000))] }, h.owner)
    expect(h.adapter.calls.length).toBeGreaterThan(2)
    expect(result.llmCalls).toHaveLength(h.adapter.calls.length)
    expect(result).not.toHaveProperty('llmStreamCall')
    for (const call of h.adapter.calls.slice(1)) {
      expect(call).toMatchObject({ provider: 'summary', model: 'small', maxTokens: 256, purpose: 'compaction' })
      expect(call).not.toHaveProperty('tools')
      expect(call).not.toHaveProperty('toolHistory')
      expect(byteSize(call)).toBeLessThanOrEqual(Math.floor((8192 - 256) * 0.8))
    }
    expect(fragment(h.adapter.calls.at(-1)!)).toContain('checkpoint 2')
    expect(result.summary).toEqual([{ type: 'text', text: `checkpoint ${h.adapter.calls.length}` }])
  })

  it('preserves every UTF-8 source byte across large tool-call fragments', async () => {
    const h = await harness()
    const input: SummarizationInput = {
      messages: [createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'conversation', model: 'large' },
        content: [{ type: 'tool-call', id: ToolCallId('large-call'), name: 'write', arguments: JSON.stringify({ text: '\u4e2d\u6587\u{1F680}'.repeat(5000) }) }],
      })],
    }
    const data = JSON.stringify({
      tools: [],
      toolHistory: h.session.toolHistory(),
      messages: input.messages.map(message => ({ role: message.role, content: message.content })),
    })
    await h.engine.run(input, h.owner)
    let assembled = ''
    for (const call of h.adapter.calls) {
      const part = fragment(call)
      expect(Buffer.from(part, 'utf8').toString('utf8')).toBe(part)
      assembled += part
      if (assembled.length >= data.length) break
    }
    expect(assembled.length).toBe(data.length)
    expect(createHash('sha256').update(assembled).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it.each([false, true])('preserves the complete huge tool result and failure flag %s', async (isError) => {
    const h = await harness()
    const callId = ToolCallId('huge-result')
    const message = createToolResultMessage({
      callId, isError, content: [{ type: 'text', text: 'result '.repeat(20_000) }],
    })
    const expected = JSON.stringify({ tools: [], toolHistory: h.session.toolHistory(), messages: [
      { role: 'tool', toolCallId: callId, isError, content: message.content },
    ] })
    const output = await h.engine.run({ messages: [message] }, h.owner)
    expect(output.llmCalls!.length).toBeGreaterThan(2)
    let data = ''
    for (const call of h.adapter.calls.slice(1)) {
      data += fragment(call)
      if (data.length >= expected.length) break
    }
    expect(data.length).toBe(expected.length)
    expect(createHash('sha256').update(data).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
    const reconstructed: unknown = JSON.parse(data)
    expect(reconstructed).toMatchObject({ messages: [{ role: 'tool', toolCallId: callId, isError }] })
  })

  it('recovers a canonical overflow even when heuristic pricing said the prefix fits', async () => {
    const h = await harness()
    h.adapter.finishFor = (_options, count) => count === 1 ? OVERFLOW : { kind: 'stop' }
    const result = await h.engine.run({ messages: [source('short history')] }, h.owner)
    expect(result.llmCalls?.[0]?.finish).toEqual(OVERFLOW)
    expect(result.llmCalls?.[0]?.request).not.toHaveProperty('system')
    expect(h.adapter.calls[1]).toHaveProperty('system')
    expect(result).not.toHaveProperty('llmStreamCall')
  })

  it('halves its bound after a bounded request is also rejected', async () => {
    const h = await harness(20_000)
    h.adapter.finishFor = (_options, count) => count <= 2 ? OVERFLOW : { kind: 'stop' }
    const result = await h.engine.run({ messages: [source('x'.repeat(40_000))] }, h.owner)
    expect(result.llmCalls?.slice(0, 2).map(call => call.finish)).toEqual([OVERFLOW, OVERFLOW])
    for (const call of h.adapter.calls.slice(2)) expect(byteSize(call)).toBeLessThanOrEqual(Math.floor((20_000 - 256) * 0.8 / 2))
  })

  it('commits only the final checkpoint and records all bounded call envelopes', async () => {
    const h = await harness()
    const before = h.session.snapshotEvents()
    const result = await replace(h)
    const events = h.session.snapshotEvents()
    expect(events.slice(0, before.length)).toEqual(before)
    expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    const summary = events.find(event => event.type === 'compaction/summary')
    expect(summary?.data.llmCalls).toHaveLength(h.adapter.calls.length)
    expect(summary?.data).not.toHaveProperty('llmStreamCall')
    expect(result.shadowedSeqs).toHaveLength(2)
    const replay = Session.create(SessionId('bounded-replay'), events)
    expect(replay.deriveMessages()).toEqual(h.session.deriveMessages())
    expect(JSON.stringify(summary?.data.llmCalls)).not.toContain('"signal"')
  })

  it.each(['provider', 'partial-truncated', 'merge-truncated', 'cancelled'] as const)(
    'preserves the complete original surface after %s failure', async (failure) => {
      const h = await harness()
      const controller = new AbortController()
      const beforeNodes = [...h.session.surface.nodes]
      const beforeMessages = h.session.deriveMessages()
      h.adapter.finishFor = (options, count) => {
        if (failure === 'cancelled' && count === 2) controller.abort(new Error('cancelled fixture'))
        if (failure === 'provider' && count === 2) return { kind: 'error', failure: { message: 'partial failed', code: 'SERVER' } }
        if (failure === 'partial-truncated' && count === 1) return { kind: 'max-tokens' }
        if (failure === 'merge-truncated' && fragment(options).startsWith('["checkpoint')) return { kind: 'max-tokens' }
        return byteSize(options) + 256 > 8192 ? OVERFLOW : { kind: 'stop' }
      }
      await expect(replace(h, controller.signal)).rejects.toThrow()
      expect(h.session.surface.nodes).toEqual(beforeNodes)
      expect(h.session.deriveMessages()).toEqual(beforeMessages)
      expect(h.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toEqual([])
      const ends = h.session.snapshotEvents().filter(event => event.type === 'compaction/end')
      expect(ends).toHaveLength(1)
      expect(ends[0]?.data.error).toBeTruthy()
      expect(ends[0]?.data.llmCalls).toHaveLength(h.adapter.calls.length)
      expect(deriveReplayScript(h.session.snapshotEvents())).toHaveLength(h.adapter.calls.length)
    },
  )

  it('stops before exceeding the configured total call allowance', async () => {
    const h = await harness(8192, { summarizationMaxCalls: 1 })
    await expect(replace(h)).rejects.toThrow(/summarizationMaxCalls/)
    expect(h.adapter.calls).toHaveLength(1)
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it('stops before sending bounded requests when instructions exhaust the input budget', async () => {
    const h = await harness(1000)
    await expect(replace(h)).rejects.toThrow(/no input room/)
    expect(h.adapter.calls).toHaveLength(1)
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it('requires declared summary capacity after canonical overflow', async () => {
    const h = await harness()
    h.adapter.resolveModel = (provider, model) => Promise.resolve({ provider, id: model, name: model })
    h.adapter.finishFor = () => OVERFLOW
    await expect(h.engine.run({ messages: [source('short')] }, h.owner)).rejects.toThrow(/adapter-declared/)
    expect(h.adapter.calls).toHaveLength(1)
  })

  it('rejects non-converging intermediate checkpoints', async () => {
    const h = await harness()
    h.adapter.finishFor = options => byteSize(options) + 256 > 8192 ? OVERFLOW : { kind: 'stop' }
    h.adapter.textFor = options => fragment(options).repeat(2)
    await expect(replace(h)).rejects.toThrow(/did not reduce/)
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it.each(['unregistered', 'tiny-registered'] as const)('respects a %s alias routed through middleware', async (initial) => {
    const h = await harness(131_072, { summarizationProvider: 'alias', summarizationModel: 'alias' })
    if (initial === 'tiny-registered') h.ctx.llm.registerAdapter(['alias'], new BudgetAdapter(1000))
    h.ctx.on('llm/stream', async function* (options, next) {
      if (options.provider === 'alias') {
        yield* this.stream({ ...options, provider: 'summary', model: 'small' })
      } else yield* next()
    })
    const result = await h.engine.run({ messages: [source('history '.repeat(3000))] }, h.owner)
    expect(h.adapter.calls).toHaveLength(1)
    expect(result).toMatchObject({ provider: 'summary', model: 'small', llmStreamCall: true })
    expect(Object.getOwnPropertySymbols(h.adapter.calls[0]!)).toEqual([])
  })

  it('records effective adapter defaults and middleware output caps on every call', async () => {
    const h = await harness()
    const high = ReasoningEffortId('high')
    h.adapter.resolveModel = (provider, model) => Promise.resolve({
      provider, id: model, name: model, context: { contextWindow: 8192 },
      reasoning: { efforts: [{ id: high, name: 'High' }], defaultEffort: high },
    })
    h.ctx.on('llm/stream', async function* (options, next) {
      options.maxTokens = 128
      yield* next()
    })
    const result = await h.engine.run({ messages: [source('x'.repeat(30_000))] }, h.owner)
    expect(result.llmCalls).toHaveLength(h.adapter.calls.length)
    for (const [index, call] of h.adapter.calls.entries()) {
      const { signal: _signal, sessionId: _sessionId, ...request } = call
      const stored = result.llmCalls![index]!
      expect(stored.request).toMatchObject({ reasoningEffort: high, maxTokens: 128 })
      expect(createHash('sha256').update(JSON.stringify(stored.request)).digest('hex'))
        .toBe(createHash('sha256').update(JSON.stringify(request)).digest('hex'))
    }
    for (const call of h.adapter.calls.slice(1)) expect(byteSize(call)).toBeLessThanOrEqual(Math.floor((8192 - 128) * 0.8))
  })

  it('serializes a file using the current execution-world handle', async () => {
    const h = await harness()
    const path = '/fixture/readonly/source.txt'
    const handle = `File source.txt: ${path}; read the verbatim stored copy`
    const projector = vi.spyOn(h.ctx.llm, 'fileRequestText').mockReturnValue(handle)
    const input = source('x'.repeat(30_000))
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [...input.content, { type: 'file', attachment: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'text/plain', bytes: 2, name: 'source.txt',
      } }],
    })
    await h.engine.run({ messages: [message] }, h.owner)
    expect(projector).toHaveBeenCalledOnce()
    expect(h.adapter.calls.slice(1).map(fragment).join('').includes(path)).toBe(true)
  })

  it.each([false, true])('accepts offloaded image history with provider pricing=%s', async (priced) => {
    const h = await harness()
    const message = createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(30_000) }, {
        type: 'image', offloaded: true,
        attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), name: 'shot', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }],
    })
    const image = message.content.find(block => block.type === 'image')!
    const placeholder = priced ? 'Read the omitted shot at /fixture/readonly/shot.png' : offloadedImageText(image.attachment)
    if (priced) {
      vi.spyOn(h.ctx.llm, 'imageRequestPricing').mockReturnValue({
        priceImages: images => images.map(() => ({ visualTokens: 0, text: placeholder })),
      })
    }
    const result = await h.engine.run({ messages: [message] }, h.owner)
    expect(result.llmCalls!.length).toBeGreaterThan(2)
    expect(h.adapter.calls.slice(1).map(fragment).join('').includes(JSON.stringify(placeholder).slice(1, -1))).toBe(true)
  })

  it('records a terminal call before cancellation in the same finish frame', async () => {
    const h = await harness()
    const controller = new AbortController()
    const before = h.session.deriveMessages()
    h.adapter.finishFor = () => {
      controller.abort(new Error('after terminal finish'))
      return { kind: 'stop' }
    }
    await expect(replace(h, controller.signal)).rejects.toThrow('after terminal finish')
    const end = h.session.snapshotEvents().find(event => event.type === 'compaction/end')
    expect(end?.data.llmCalls).toHaveLength(1)
    expect(end?.data.llmCalls?.[0]?.finish).toEqual({ kind: 'stop' })
    expect(deriveReplayScript(h.session.snapshotEvents())).toHaveLength(1)
    expect(h.session.deriveMessages()).toEqual(before)
  })

  it('records completed requests even when the final checkpoint fails the shrink check', async () => {
    const h = await harness(131_072)
    h.adapter.textFor = () => 'unchanged '.repeat(10_000)
    await expect(replace(h)).rejects.toThrow(/not smaller/)
    const end = h.session.snapshotEvents().find(event => event.type === 'compaction/end')
    expect(end?.data.llmCalls).toHaveLength(1)
    expect(deriveReplayScript(h.session.snapshotEvents())).toHaveLength(1)
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it('counts the rejected warm call toward the total recovery allowance', async () => {
    const h = await harness(8192, { summarizationMaxCalls: 2 })
    await expect(replace(h)).rejects.toThrow(/summarizationMaxCalls/)
    expect(h.adapter.calls).toHaveLength(2)
    const end = h.session.snapshotEvents().find(event => event.type === 'compaction/end')
    expect(end?.data.llmCalls?.[0]?.finish).toEqual(OVERFLOW)
    expect(end?.data.llmCalls).toHaveLength(2)
    expect(deriveReplayScript(h.session.snapshotEvents())).toHaveLength(2)
  })

  it('uses declared route metadata and explicit fallback caps when middleware owns replay', async () => {
    const h = await harness()
    const requests: GenerateOptions[] = []
    h.ctx.on('llm/stream', async function* (options) {
      requests.push(options)
      if (options.system === undefined) {
        yield { type: 'finish', reason: OVERFLOW }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'replayed checkpoint' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const result = await h.engine.run({ messages: [source('x'.repeat(20_000))] }, h.owner)
    expect(result.llmCalls).toHaveLength(requests.length)
    expect(result.llmCalls![0]!.request.maxTokens).toBe(256)
    expect(result.llmCalls!.slice(1).every(call => call.request.maxTokens === 256)).toBe(true)
    expect(h.adapter.calls).toEqual([])
  })

  it.each([8192, 131_072])('uses an explicit recovery cap after an uncapped warm route at window %s', async (window) => {
    const h = await harness(window)
    h.ctx.on('llm/stream', async function* (options, next) {
      if (options.system === undefined) delete options.maxTokens
      yield* next()
    })
    const result = await h.engine.run({ messages: [source('x'.repeat(20_000))] }, h.owner)
    expect(h.adapter.calls[0]!.maxTokens).toBeUndefined()
    if (window === 8192) {
      expect(result.llmCalls![0]!.request.maxTokens).toBeUndefined()
      expect(result.llmCalls!.slice(1).every(call => call.request.maxTokens === 256)).toBe(true)
    } else {
      expect(result.llmStreamCall).toBe(true)
      expect(result.maxTokens).toBeUndefined()
    }
  })

  it('keeps an unfinished middleware stream explicit rather than fabricating a stop', async () => {
    const h = await harness()
    h.ctx.on('llm/stream', async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
    })
    await expect(replace(h)).rejects.toThrow(/without a terminal finish/)
    const end = h.session.snapshotEvents().find(event => event.type === 'compaction/end')
    expect(end?.data).not.toHaveProperty('llmCalls')
    expect(h.session.surface.nodes).toHaveLength(2)
  })

  it('rejects an unsupported extension block only after a confirmed prefix overflow', async () => {
    const h = await harness()
    const message = createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'summary-test-extension', text: 'extension payload '.repeat(2000) },
    ] })
    await expect(h.engine.run({ messages: [message] }, h.owner)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(h.adapter.calls).toHaveLength(1)
  })

  it('requests durable offload instead of replacing visual history with metadata', async () => {
    const h = await harness()
    const image = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'x'.repeat(100_000) }, {
        type: 'image', attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }],
    })
    await expect(h.engine.run({ messages: [image] }, h.owner)).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED' })
    expect(h.adapter.calls).toHaveLength(1)
  })

  it('validates and resolves exact-model recovery settings', () => {
    for (const summarizationInputRatio of [0, -1, 1.01, Number.NaN]) {
      expect(() => resolveConfig({ summarizationInputRatio })).toThrow(/summarizationInputRatio/)
    }
    for (const summarizationMaxCalls of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveConfig({ summarizationMaxCalls })).toThrow(/summarizationMaxCalls/)
    }
    const policy = resolveTargetPolicy(resolveConfig({ modelPolicies: [{
      provider: 'route', model: 'special', summarizationInputRatio: 0.5, summarizationMaxCalls: 7,
    }] }), { provider: 'route', model: 'special' })
    expect(policy).toMatchObject({ summarizationInputRatio: 0.5, summarizationMaxCalls: 7 })
  })
})
