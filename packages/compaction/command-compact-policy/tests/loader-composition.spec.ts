import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Commands from '@deepseek-ai/dsh-commands'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import yaml from 'js-yaml'
import * as policy from '../src/index.ts'
import { hasExpression, scanPreset } from '../src/presets.ts'

class Adapter extends LlmAdapter {
  readonly resolved: string[] = []
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'catalog', name: 'Catalog' }]) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolved.push(model)
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: 100_000 }, defaultMaxTokens: 5_000 })
  }
  override async * stream(): AsyncIterable<StreamChunk> { throw new Error('policy commands must make no model request') }
}

class CustomEngine extends CompactionEngine {
  override compactIfNeeded() { return Promise.resolve(null) }
  override compactNow() { return Promise.resolve(null) }
  override compactRegion(): never { throw new Error('custom backend must remain untouched') }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function preset(id: string, backend = '@deepseek-ai/dsh-compaction-basic') {
  return {
    id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: {
      id, plugins: [{ id: 'realm', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
        { id: 'backend', name: backend, config: { thresholdRatio: 0.7, headroomTokens: 20_000, retainTokens: 100,
          auto: false, compactionRetries: 3, maxOverflowRetries: 2,
          summarizationProvider: 'test', summarizationModel: 'summary',
          modelPolicies: [{ provider: 'test', model: 'unlisted', headroomTokens: 30_000 }] } },
        { id: 'conditional', name: '@test/noop', disabled: { __jsExpr: 'true' } },
      ] }],
    },
  }
}

async function harness(
  headroomTokens: number | null = 16_384, extra: Record<string, unknown>[] = [], included?: Record<string, unknown>[],
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compact-policy-'))
  roots.push(root)
  const dir = join(root, 'profile')
  initProfile(dir, ['test-policy-bundle'])
  const bundle = join(dir, 'node_modules', 'test-policy-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-policy-bundle', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const rows: Record<string, unknown>[] = [
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'meter', name: '@deepseek-ai/dsh-token-meter' },
    { id: 'prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' } },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'agents', name: '@deepseek-ai/dsh-agent' },
    { id: 'loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { id: 'commands', name: '@deepseek-ai/dsh-commands' },
    { id: 'presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'first' } },
    { id: 'outer', name: 'cordis:group', group: true, config: [preset('first'), preset('second')] },
    preset('custom', '@test/custom'),
    { id: 'preset-none', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'none', plugins: [] } },
    { id: 'policy', name: '@deepseek-ai/dsh-command-compact-policy', config: headroomTokens === null ? {} : { headroomTokens } },
  ]
  rows.push(...extra)
  if (included !== undefined) {
    await writeFile(join(dir, 'included.yml'), yaml.dump(included, { schema: entryListSchema }))
  }
  await writeFile(join(bundle, 'cordis.patch.yml'), yaml.dump([{ insert: rows }], { schema: entryListSchema }))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['test-policy-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'),
    cwd: root, home: root, overlays: [], telemetryDisabledEnv: undefined }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const modules = new Map<string, unknown>([
    ['cordis:group', Group], ['cordis:include', Include],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjections], ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', Commands], ['@deepseek-ai/dsh-agent-preset-registry', AgentPresets],
    ['@deepseek-ai/dsh-agent-preset', AgentPreset], ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
    ['@deepseek-ai/dsh-command-compact-policy', policy], ['@test/custom', CustomEngine],
  ])
  vi.spyOn(EntryTree.prototype, 'import').mockImplementation((name) => {
    if (!modules.has(name)) throw new Error(`unexpected test module ${name}`)
    return Promise.resolve(modules.get(name))
  })
  ctx.provide('profileContext', profile)
  await ctx.plugin(ConfigEditor)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  const adapter = new Adapter()
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error(`Loader failed to publish llm: ${JSON.stringify([...ctx.loader.entries()].map(row => ({ id: row.options.id, state: row.fiber?.state })))}`)
  }
  ctx.effect(() => llm.registerAdapter(['test'], adapter))
  const create = async (id: string, agentPreset = 'first') => (await ctx.agents.create({
    sessionId: SessionId(id), agentOptions: { provider: 'test', model: 'unlisted', maxTokens: 99 },
    setup: async (child) => { await ctx.agentPresets.mount(child, agentPreset) },
  })).agent
  const agent = await create('receiving')
  agent.session.append('request/header', { reason: 'initial',
    header: { config: { provider: 'test', model: 'unlisted', maxTokens: 20_000 } } })
  const run = async (suffix = '', controller = new AbortController()) => {
    const result = await ctx.commands.execute(agent, `/compact-policy${suffix}`, [], controller.signal)
    if (result === undefined) throw new Error('policy command was missing')
    return result
  }
  const engine = (owner = agent) => {
    const backend = ctx.agentPresets.serviceFor(owner, 'compaction')
    if (!(backend instanceof BasicCompactionEngine)) throw new Error('expected Basic backend')
    return (backend as BasicCompactionEngine & { [symbols.original]?: BasicCompactionEngine })[symbols.original] ?? backend
  }
  return { ctx, root, profile, agent, adapter, create, run, engine }
}

describe('compact-policy real Loader/profile composition', () => {
  it('keeps status observational and prices the receiving durable route outside the catalog', async () => {
    const test = await harness()
    const before = await readFile(test.profile.patchPath, 'utf8')
    const config = test.engine().config
    const output = await test.run()
    expect(output.result.kind).toBe('success')
    expect(output.result.text).toContain('ratio=0.8, headroom=16384')
    expect(output.result.text).toContain('preview (adapter default only) test/catalog: window=100000, reserve=5000, threshold=70000, limit=ratio')
    expect(output.result.text).toContain('routed test/unlisted: window=100000, reserve=20000, threshold=50000, limit=budget')
    expect(test.adapter.resolved).toContain('unlisted')
    expect(test.engine().config).toBe(config)
    expect(await readFile(test.profile.patchPath, 'utf8')).toBe(before)
    expect(test.agent.options.maxTokens).toBe(99)
    expect(test.agent.session.deriveMessages()).toEqual([])
    expect(test.agent.session.snapshotEvents().filter(event => event.type.startsWith('command/')).map(event => event.type))
      .toEqual(['command/run', 'command/done'])
    expect('default' in policy).toBe(false)
    expect(test.ctx.loader.unwrapExports(policy)).toBe(policy)
    const usage = await test.run(' invalid')
    expect(usage.result).toEqual({ kind: 'error', text: 'Usage: /compact-policy [status|apply]' })
  })

  it('updates saved literal configs and old/current published generations while pinning caps', async () => {
    const test = await harness()
    const old = test.engine()
    const entry = test.ctx.configEditor.entries().find(row => row.options.id === 'preset-first')
    if (entry === undefined) throw new Error('preset-first was missing')
    await test.ctx.configEditor.edit(entry, current => ({ ...current, description: 'new generation' }))
    const child = (await test.ctx.agents.create({ sessionId: SessionId('child'),
      setup: (ctx) => { test.ctx.agentPresets.composeFrom(ctx, test.agent.ctx) } })).agent
    const fresh = await test.create('fresh')
    expect(test.engine(fresh) === old).toBe(false)
    expect(test.engine(child) === old).toBe(true)
    const output = await test.run(' apply')
    expect(output.result.kind).toBe('success')
    expect(output.result.text).toContain('saved preset-first: applied 1 literal backend(s)')
    for (const agent of [test.agent, child, fresh]) {
      expect(test.engine(agent).config).toMatchObject({ thresholdRatio: 0.8, headroomTokens: 16_384,
        maxTokens: 20_000, retainTokens: 100, auto: false, compactionRetries: 3, maxOverflowRetries: 2,
        summarizationProvider: 'test', summarizationModel: 'summary',
        modelPolicies: [{ provider: 'test', model: 'unlisted', thresholdRatio: 0.8, headroomTokens: 16_384, maxTokens: 30_000 }] })
    }
    const persisted = await readFile(test.profile.patchPath, 'utf8')
    expect(persisted).toContain('maxTokens: 30000')
    expect(persisted).toContain('disabled: !!js true')
    const next = await test.create('next')
    expect(test.engine(next).config).toEqual(old.config)
    const repeat = await test.run(' apply')
    expect(repeat.result.text).toContain('saved preset-first: already configured')
    expect(await readFile(test.profile.patchPath, 'utf8')).toBe(persisted)
    expect(test.agent.session.requestHeader()?.config.maxTokens).toBe(20_000)
    expect(test.agent.session.deriveMessages()).toEqual([])
  })

  it('validates all shared-owner reservations once and reports a shared failure honestly', async () => {
    const test = await harness()
    const child = (await test.ctx.agents.create({ sessionId: SessionId('expensive'),
      setup: (ctx) => { test.ctx.agentPresets.composeFrom(ctx, test.agent.ctx) } })).agent
    child.session.append('request/header', { reason: 'initial',
      header: { config: { provider: 'test', model: 'unlisted', maxTokens: 90_000 } } })
    const owner = test.engine()
    const before = owner.config
    const apply = vi.spyOn(owner, 'applyPressurePolicy')
    const output = await test.run(' apply')
    expect(output.result.kind).toBe('error')
    expect(output.result.text).toContain('live expensive (preset=first): shared backend failed')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(owner.config).toBe(before)
  })

  it('leaves headroom and summary caps unchanged with default config', async () => {
    const test = await harness(null)
    const before = test.engine().config
    const output = await test.run(' apply')
    expect(output.result.text).toContain('headroom=preserve existing')
    expect(test.engine().config).toEqual({ ...before, thresholdRatio: 0.8,
      modelPolicies: before.modelPolicies.map(row => ({ ...row, thresholdRatio: 0.8 })) })
  })

  it('reports independent saved-entry failures and leaves custom or absent backends untouched', async () => {
    const test = await harness()
    const custom = await test.create('custom-agent', 'custom')
    await test.create('no-backend', 'none')
    const edit = test.ctx.configEditor.edit.bind(test.ctx.configEditor)
    vi.spyOn(test.ctx.configEditor, 'edit').mockImplementation(async (entry, change) => {
      if (entry.options.id === 'preset-second') throw new Error('second write failed')
      await edit(entry, change)
    })
    const output = await test.run(' apply')
    expect(output.result.kind).toBe('error')
    expect(output.result.text).toContain('saved preset-first: applied')
    expect(output.result.text).toContain('saved preset-second: failed second write failed')
    expect(output.result.text).toContain('custom-agent (preset=custom): skipped custom backend')
    expect(output.result.text).toContain('no-backend (preset=none): skipped no compaction backend')
    expect(test.ctx.agentPresets.serviceFor(custom, 'compaction') instanceof CustomEngine).toBe(true)
    expect(test.engine().config.thresholdRatio).toBe(0.8)
  })

  it('serializes invocations and drains an in-flight entry on cancellation/disposal', async () => {
    const test = await harness()
    const started = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const edit = test.ctx.configEditor.edit.bind(test.ctx.configEditor)
    const calls: string[] = []
    vi.spyOn(test.ctx.configEditor, 'edit').mockImplementation(async (entry, change) => {
      calls.push(entry.options.id)
      await edit(entry, change)
      started.resolve(undefined)
      await finish.promise
    })
    const controller = new AbortController()
    const first = test.run(' apply', controller)
    await started.promise
    const queuedController = new AbortController()
    const second = test.run(' apply', queuedController)
    controller.abort(new Error('stop first'))
    queuedController.abort(new Error('stop queued'))
    await expect(first).rejects.toThrow('stop first')
    await expect(second).rejects.toThrow('stop queued')
    const entry = [...test.ctx.loader.entries()].find(row => row.options.id === 'policy')
    if (entry?.fiber === undefined) throw new Error('policy fiber was missing')
    let disposed = false
    const disposal = entry.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(test.ctx.commands.find(test.agent, 'compact-policy')).toBeUndefined()
    expect(disposed).toBe(false)
    expect(calls).toEqual(['preset-first'])
    finish.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
    expect(calls).toEqual(['preset-first'])
    expect(await readFile(test.profile.patchPath, 'utf8')).toContain('headroomTokens: 16384')
  })

  it('reports conditional, disabled, inactive, expression and invalid saved declarations without mutation', async () => {
    const test = await harness(16_384, [
      { ...preset('disabled'), disabled: true },
      { id: 'conditional-parent', name: 'cordis:group', group: true, disabled: { __jsExpr: 'false' }, config: [preset('conditional')] },
      { id: 'inactive', name: '@deepseek-ai/dsh-agent-preset', config: null },
      { id: 'expression', name: '@deepseek-ai/dsh-agent-preset', config: { __jsExpr: "({ id: 'expression', plugins: [] })" } },
      { id: 'invalid', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'invalid', plugins: [
        { id: 'bad-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { unknown: 1 } },
      ] } },
    ])
    const output = await test.run()
    expect(output.result.text).toContain('saved preset-disabled (preset=disabled): skipped disabled entry or parent')
    expect(output.result.text).toContain('saved preset-conditional (preset=conditional): skipped conditional entry or parent')
    expect(output.result.text).toContain('saved inactive (preset=unknown): skipped inactive entry')
    expect(output.result.text).toContain('saved expression (preset=unknown): skipped expression preset config')
    expect(output.result.text).toContain('unknown key')
    const applied = await test.run(' apply')
    expect(applied.result.text).toContain('saved expression: skipped expression preset config')
    expect(applied.result.text).toContain('saved invalid: skipped BasicCompactionConfig')
  })

  it('inspects read-only Includes and distinguishes custom, absent, route-free and nonreceiving Agents', async () => {
    const test = await harness(16_384, [
      { id: 'nested', name: 'cordis:include', config: { path: 'included.yml' } },
    ], [preset('included')])
    await test.create('custom-view', 'custom')
    await test.create('none-view', 'none')
    await test.create('preview-view')
    await test.ctx.agents.create({ sessionId: SessionId('route-free'),
      setup: async (ctx) => { await test.ctx.agentPresets.mount(ctx, 'first') } })
    await test.ctx.agents.create({ sessionId: SessionId('preset-free') })
    const output = await test.run()
    expect(output.result.text).toContain('custom backend; pressure inspection unsupported')
    expect(output.result.text).toContain('none-view (preset=none): no compaction backend')
    expect(output.result.text).toContain('live preset-free (preset=none): no compaction backend')
    expect(output.result.text).toContain('live preview-view (preset=first)')
    expect(output.result.text).toContain('routed capacity unresolved; no effective threshold claimed')
    expect(output.result.text).toContain('preset included: no root-addressable configuration entry')
    expect((await test.run(' apply')).result.text).toContain('live preset-free (preset=none): skipped no compaction backend')
  })

  it('reports catalog and exact-model lookup failures without claiming a routed threshold', async () => {
    const test = await harness()
    vi.spyOn(test.adapter, 'listModels').mockRejectedValue(new Error('directory offline'))
    vi.spyOn(test.adapter, 'resolveModel').mockRejectedValue('model unavailable')
    const output = await test.run()
    expect(output.result.text).toContain('catalog test: directory offline')
    expect(output.result.text).toContain('model test/unlisted: model unavailable')
    expect(output.result.text).toContain('routed capacity unresolved; no effective threshold claimed')
  })

  it('keeps unknown capacities explicit during both inspection and pressure updates', async () => {
    const test = await harness()
    vi.spyOn(test.adapter, 'resolveModel').mockImplementation((provider, id) => Promise.resolve({ provider, id, name: id }))
    expect((await test.run()).result.text).toContain('context capacity unknown, summaryCap=30000')
    expect((await test.run(' apply')).result.kind).toBe('success')
  })

  it('prices absent output reservations as zero and identifies a coincident ratio/budget limit', async () => {
    const test = await harness()
    vi.spyOn(test.adapter, 'resolveModel').mockImplementation((provider, id) => Promise.resolve({ provider, id, name: id,
      context: { contextWindow: 100_000 } }))
    test.agent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'unlisted' } } })
    expect((await test.run()).result.text).toContain('reserve=0, threshold=70000, limit=ratio+budget')
    expect((await test.run(' apply')).result.kind).toBe('success')
  })

  it('reports an invalid durable reservation through inspection without mutating policy', async () => {
    const test = await harness()
    const before = test.engine().config
    test.agent.session.append('request/header', { reason: 'initial',
      header: { config: { provider: 'test', model: 'unlisted', maxTokens: 100_000 } } })
    expect((await test.run()).result.text).toContain('leaving no message budget')
    expect(test.engine().config).toBe(before)
  })

  it('persists a clean literal backend without adding model overrides or skipped-branch diagnostics', async () => {
    const test = await harness()
    const entry = test.ctx.configEditor.entries().find(row => row.options.id === 'preset-first')
    if (entry === undefined) throw new Error('preset-first was missing')
    await test.ctx.configEditor.edit(entry, current => ({ ...current, plugins: [
      { id: 'clean-realm', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
        { id: 'basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
          thresholdRatio: 0.7, headroomTokens: 20_000, retainTokens: 100, auto: false,
        } },
      ] },
    ] }))
    expect((await test.run(' apply')).result.text).toContain('saved preset-first: applied 1 literal backend(s)\n')
  })

  it('canonicalizes an owner returned through the public service lookup method', async () => {
    const test = await harness()
    const backend = test.engine()
    const lookup = test.ctx.agentPresets.serviceFor(test.agent, 'compaction')
    if (!(lookup instanceof BasicCompactionEngine)) throw new Error('expected Basic lookup')
    const original = (lookup as BasicCompactionEngine & { [symbols.original]: BasicCompactionEngine })[symbols.original]
    expect(lookup === backend).toBe(false)
    expect(original === backend).toBe(true)
    expect((await test.run()).result.text).toContain('live receiving (preset=first, receiving)')
  })

  it('rejects scoped placement and invalid pressure settings at activation', async () => {
    const test = await harness()
    const scope = createScope(test.ctx, {})
    await expect(scope.ctx.plugin(policy, { thresholdRatio: 0.8 })).rejects.toThrow('Host root')
    await expect(test.ctx.plugin(policy, { thresholdRatio: 0 })).rejects.toThrow('must be in')
    await scope.dispose()
  })
})

describe('raw preset branches', () => {
  it('preserves expressions and disabled groups instead of evaluating or materializing them', () => {
    const expression = { __jsExpr: 'config.value' }
    const raw = { plugins: [
      { id: 'expr', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: expression } },
      { id: 'off', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
      { id: 'group', name: 'cordis:group', group: true, disabled: expression, config: [] },
      { id: 'expr-list', name: 'cordis:group', group: true, config: expression },
      { id: 'bad', name: '@deepseek-ai/dsh-compaction-basic', config: [] },
      'raw',
    ] }
    const before = structuredClone(raw)
    const scan = scanPreset(raw)
    expect(scan.rows).toEqual([])
    expect(scan.notes.join('\n')).toContain('skipped expression config')
    expect(scan.notes.join('\n')).toContain('skipped disabled row')
    expect(scan.notes.join('\n')).toContain('skipped conditional row')
    expect(scan.notes.join('\n')).toContain('skipped non-literal config')
    expect(scan.notes.join('\n')).toContain('skipped non-literal row')
    expect(hasExpression(raw)).toBe(true)
    expect(raw).toEqual(before)
    expect(() => scanPreset({ plugins: [{ name: '@deepseek-ai/dsh-compaction-basic', config: { unknown: 1 } }] })).toThrow('unknown key')
    expect(scanPreset({ plugins: 1 }).notes).toContain('plugins: skipped non-literal plugin list')
    expect(scanPreset({ plugins: [{ name: '@deepseek-ai/dsh-compaction-basic' }] }).rows).toHaveLength(1)
  })
})
