/** Opt-in human command for pressure-only compaction policy updates. */
import type { Context } from '@deepseek-ai/cordis'
import { FiberState, symbols } from '@deepseek-ai/cordis'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  BasicCompactionEngine,
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  withPressurePolicy,
} from '@deepseek-ai/dsh-compaction-basic'
import type { PressurePolicyTarget, ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-config-editor'
import { isRecord, scanPreset } from './presets.ts'
import type { PresetScan } from './presets.ts'

export const name = 'command-compact-policy'
export const inject = ['commands', 'agents', 'agentPresets', 'configEditor', 'llm']

/** Deployment-selected pressure settings; no model, request, or summary cap is configured here. */
export interface Config {
  /** Pressure fraction applied to defaults and existing model overrides. Defaults to 0.8. */
  readonly thresholdRatio: number
  /** Replacement headroom; omission preserves each existing value. */
  readonly headroomTokens?: number
}

export const Config: z<Config> = z.object({
  thresholdRatio: z.number().default(0.8),
  headroomTokens: z.number().step(1).min(0),
})

interface LiveBackend {
  readonly agent: Agent
  readonly preset: string | undefined
  readonly engine: CompactionEngine | undefined
}

interface SavedPreset {
  readonly entry: Entry
  readonly config: Record<string, unknown>
  readonly scan: PresetScan | undefined
  readonly problem: string | undefined
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function blocked(entry: Entry): string | undefined {
  let current: Entry | undefined = entry
  while (current !== undefined) {
    if (isJsExpr(current.options.disabled)) return 'conditional entry or parent'
    if (current.options.disabled === true) return 'disabled entry or parent'
    current = current.parent.ctx.fiber.entry
  }
  return entry.fiber?.state === FiberState.ACTIVE ? undefined : 'inactive entry'
}

function savedPresets(ctx: Context): SavedPreset[] {
  return ctx.configEditor.entries()
    .filter(entry => entry.options.name === '@deepseek-ai/dsh-agent-preset')
    .map((entry) => {
      const raw: unknown = entry.options.config
      const config = isRecord(raw) ? structuredClone(raw) : {}
      const problem = blocked(entry) ?? (isJsExpr(raw) ? 'expression preset config' : undefined)
      if (problem !== undefined) return { entry, config, scan: undefined, problem }
      try {
        return { entry, config, scan: scanPreset(config), problem: undefined }
      } catch (error) {
        return { entry, config, scan: undefined, problem: detail(error) }
      }
    })
}

function liveBackends(ctx: Context): LiveBackend[] {
  return ctx.agents.list().map((agent) => {
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
    // Cordis gives each service lookup a fresh caller proxy; deduplicate its owner.
    const owner = engine === undefined ? undefined
      : (engine as CompactionEngine & { [symbols.original]?: CompactionEngine })[symbols.original] ?? engine
    return { agent, preset: ctx.agentPresets.composedPreset(agent.ctx), engine: owner }
  })
}

function route(agent: Agent): { provider: string; model: string } | undefined {
  const config = agent.session.requestHeader()?.config ?? agent.options
  return config.provider && config.model ? { provider: config.provider, model: config.model } : undefined
}

/** Model directories are advisory; exact configured and durably routed targets join them. */
async function modelInfo(
  ctx: Context,
  saved: readonly SavedPreset[],
  live: readonly LiveBackend[],
  signal: AbortSignal,
  notes: string[],
): Promise<LlmResolvedModelInfo[]> {
  const targets = new Map<string, { provider: string; model: string }>()
  const add = (provider: string, model: string): void => { targets.set(`${provider}\u0000${model}`, { provider, model }) }
  for (const provider of ctx.llm.listProviders()) {
    signal.throwIfAborted()
    try {
      for (const model of await ctx.llm.listModels(provider.id)) add(provider.id, model.id)
    } catch (error) {
      signal.throwIfAborted()
      notes.push(`catalog ${provider.id}: ${detail(error)}`)
    }
  }
  for (const { agent, engine } of live) {
    const target = route(agent)
    if (target !== undefined) add(target.provider, target.model)
    if (engine instanceof BasicCompactionEngine) {
      for (const policy of engine.config.modelPolicies) add(policy.provider, policy.model)
    }
  }
  for (const preset of saved) {
    for (const row of preset.scan?.rows ?? []) {
      for (const policy of row.config.modelPolicies ?? []) add(policy.provider, policy.model)
    }
  }
  const models: LlmResolvedModelInfo[] = []
  for (const target of targets.values()) {
    signal.throwIfAborted()
    try {
      models.push(await ctx.llm.resolveModelInfo(target.provider, target.model, signal))
    } catch (error) {
      signal.throwIfAborted()
      notes.push(`model ${target.provider}/${target.model}: ${detail(error)}`)
    }
  }
  signal.throwIfAborted()
  return models
}

function budgets(models: readonly LlmResolvedModelInfo[], agents: readonly Agent[] = []): PressurePolicyTarget[] {
  const targets: PressurePolicyTarget[] = []
  for (const model of models) {
    if (model.context === undefined) continue
    const target = { provider: model.provider, model: model.id }
    targets.push({ target, contextWindow: model.context.contextWindow, reservedCompletionTokens: model.defaultMaxTokens ?? 0 })
    for (const agent of agents) {
      const header = agent.session.requestHeader()?.config
      if (header?.provider !== target.provider || header.model !== target.model) continue
      targets.push({ target, contextWindow: model.context.contextWindow,
        reservedCompletionTokens: header.maxTokens ?? model.defaultMaxTokens ?? 0 })
    }
  }
  return targets
}

function validateBudgets(config: ResolvedConfig, targets: readonly PressurePolicyTarget[]): void {
  for (const { target, contextWindow, reservedCompletionTokens } of targets) {
    resolveCompactSpec(resolveTargetPolicy(config, target), contextWindow, reservedCompletionTokens)
  }
}

function policyLine(config: ResolvedConfig): string {
  return `ratio=${config.thresholdRatio}, headroom=${config.headroomTokens}, summaryCap=${config.maxTokens}, auto=${config.auto}`
}

function pressureLine(config: ResolvedConfig, model: LlmResolvedModelInfo, agent?: Agent): string {
  const target = { provider: model.provider, model: model.id }
  const label = `${target.provider}/${target.model}`
  const policy = resolveTargetPolicy(config, target)
  const header = agent?.session.requestHeader()?.config
  const actual = header?.provider === target.provider && header.model === target.model
  const reserve = actual ? header.maxTokens ?? model.defaultMaxTokens ?? 0 : model.defaultMaxTokens ?? 0
  const source = actual ? 'routed' : 'preview (adapter default only)'
  if (model.context === undefined) return `  ${source} ${label}: context capacity unknown, summaryCap=${policy.maxTokens}`
  const window = model.context.contextWindow
  try {
    const spec = resolveCompactSpec(policy, window, reserve)
    const ratioLimit = window * policy.thresholdRatio
    const budgetLimit = window - reserve - policy.headroomTokens
    const limit = ratioLimit === budgetLimit ? 'ratio+budget' : ratioLimit < budgetLimit ? 'ratio' : 'budget'
    return `  ${source} ${label}: window=${window}, reserve=${reserve}, threshold=${spec.thresholdTokens}, `
      + `limit=${limit}, retained=${spec.retainTokens}, summaryCap=${policy.maxTokens}`
  } catch (error) {
    return `  ${source} ${label}: ${detail(error)}`
  }
}

async function execute(ctx: Context, config: Config, invocation: CommandInvocation): Promise<CommandResult> {
  const mode = invocation.rawInput.trim() || 'status'
  if (mode !== 'status' && mode !== 'apply') return { kind: 'error', text: 'Usage: /compact-policy [status|apply]' }
  const { signal } = invocation
  signal.throwIfAborted()
  const saved = savedPresets(ctx)
  const live = liveBackends(ctx)
  const notes: string[] = []
  const models = await modelInfo(ctx, saved, live, signal, notes)
  const lines = [`Pressure policy ${mode}: ratio=${config.thresholdRatio}, headroom=${config.headroomTokens ?? 'preserve existing'}.`,
    'Request caps, model windows, retention, automatic mode, summary routes/caps, and retries stay unchanged.']
  let failed = false
  if (mode === 'apply') {
    lines.push('Atomic per saved entry and per live backend; the complete apply is not one transaction.')
    try {
      for (const preset of saved) {
        signal.throwIfAborted()
        const label = `saved ${preset.entry.options.id}`
        if (preset.problem !== undefined || preset.scan?.rows.length === 0) {
          lines.push(`${label}: skipped ${preset.problem ?? preset.scan?.notes.join('; ')}`)
          continue
        }
        try {
          const preview = structuredClone(preset.config)
          const scan = scanPreset(preview)
          for (const row of scan.rows) row.row.config = withPressurePolicy(row.config, config)
          if (isDeepStrictEqual(preview, preset.config)) {
            lines.push(`${label}: already configured`)
            continue
          }
          let count = 0
          await ctx.configEditor.edit(preset.entry, (current) => {
            signal.throwIfAborted()
            const scan = scanPreset(current)
            const known = budgets(models, live.filter(row => row.preset === current.id).map(row => row.agent))
            const changes = scan.rows.map((row) => {
              const next = withPressurePolicy(row.config, config)
              validateBudgets(resolveConfig(next), known)
              return { row, next }
            })
            count = changes.length
            for (const { row, next } of changes) row.row.config = next
            return current
          })
          lines.push(`${label}: applied ${count} literal backend(s)${preset.scan?.notes.length ? `; ${preset.scan.notes.join('; ')}` : ''}`)
        } catch (error) {
          signal.throwIfAborted()
          failed = true
          lines.push(`${label}: failed ${detail(error)}`)
        }
      }
      const outcomes = new Map<BasicCompactionEngine, string>()
      const currentLive = liveBackends(ctx)
      for (const row of currentLive) {
        signal.throwIfAborted()
        const label = `live ${row.agent.id} (preset=${row.preset ?? 'none'})`
        if (!(row.engine instanceof BasicCompactionEngine)) {
          lines.push(`${label}: skipped ${row.engine === undefined ? 'no compaction backend' : 'custom backend'}`)
          continue
        }
        const shared = outcomes.get(row.engine)
        if (shared !== undefined) {
          lines.push(`${label}: shared backend ${shared}`)
          continue
        }
        try {
          const agents = currentLive.filter(other => other.engine === row.engine).map(other => other.agent)
          row.engine.applyPressurePolicy(config, budgets(models, agents))
          outcomes.set(row.engine, `applied ${policyLine(row.engine.config)}`)
          lines.push(`${label}: ${outcomes.get(row.engine)}`)
        } catch (error) {
          failed = true
          outcomes.set(row.engine, `failed ${detail(error)}`)
          lines.push(`${label}: ${outcomes.get(row.engine)}`)
        }
      }
    } finally {
      if (signal.aborted) ctx.logger.info(`compact-policy cancelled; completed entries remain committed:\n${lines.join('\n')}`)
    }
  } else {
    for (const preset of saved) {
      const id = typeof preset.config.id === 'string' ? preset.config.id : 'unknown'
      lines.push(`saved ${preset.entry.options.id} (preset=${id}):${preset.problem === undefined ? '' : ` skipped ${preset.problem}`}`)
      for (const note of preset.scan?.notes ?? []) lines.push(`  ${note}`)
      for (const row of preset.scan?.rows ?? []) {
        const effective = resolveConfig(row.config)
        lines.push(`  ${row.label}: ${policyLine(effective)}`)
        for (const model of models) lines.push(pressureLine(effective, model))
      }
    }
    for (const row of live) {
      const label = `live ${row.agent.id} (preset=${row.preset ?? 'none'}${row.agent === invocation.agent ? ', receiving' : ''})`
      if (!(row.engine instanceof BasicCompactionEngine)) {
        lines.push(`${label}: ${row.engine === undefined ? 'no compaction backend' : 'custom backend; pressure inspection unsupported'}`)
        continue
      }
      lines.push(`${label}: ${policyLine(row.engine.config)}`)
      const target = route(row.agent)
      const model = models.find(info => info.provider === target?.provider && info.id === target.model)
      if (model === undefined) lines.push('  routed capacity unresolved; no effective threshold claimed')
      else lines.push(pressureLine(row.engine.config, model, row.agent))
    }
    const editable = new Set(saved.map(row => row.config.id))
    for (const preset of await ctx.agentPresets.list()) {
      if (!editable.has(preset.id)) lines.push(`preset ${preset.id}: no root-addressable configuration entry`)
    }
  }
  lines.push(...notes)
  signal.throwIfAborted()
  return { kind: failed ? 'error' : 'success', text: lines.join('\n') }
}

/**
 * Register the opt-in pressure command outside all preset and Agent scopes.
 * @param ctx - Host context with public configuration, preset, Agent and model APIs.
 * @param config - explicit deployment-selected pressure settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) !== undefined) throw new Error('command-compact-policy must be mounted at the Host root, outside agent presets')
  if (!Number.isFinite(config.thresholdRatio) || config.thresholdRatio <= 0 || config.thresholdRatio > 1) {
    throw new Error('compact-policy thresholdRatio must be in (0, 1]')
  }
  const lifetime = new AbortController()
  const active = new Set<Promise<CommandResult>>()
  let tail: Promise<void> = Promise.resolve()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const signal = AbortSignal.any([invocation.signal, lifetime.signal])
    const operation = tail.then(() => execute(ctx, config, { ...invocation, signal }))
    tail = operation.then(() => undefined, () => undefined)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }
  ctx.effect(function* () {
    yield async () => {
      lifetime.abort(new Error('compact-policy plugin disposed'))
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact-policy'),
      name: 'compact-policy',
      description: 'Inspect or apply compaction pressure settings',
      input: { hint: 'status|apply' },
      handler,
    })
  }, 'compact-policy lifecycle')
}
