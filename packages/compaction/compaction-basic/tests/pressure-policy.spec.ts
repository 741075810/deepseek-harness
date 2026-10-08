import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine, resolveConfig, resolveTargetPolicy, withPressurePolicy } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('pressure-only configuration', () => {
  const source: BasicCompactionConfig = {
    thresholdRatio: 0.7, headroomTokens: 20_000, retainTokens: 100,
    summarizationProvider: 'summary', summarizationModel: 'summary-model',
    compactionRetries: 3, maxOverflowRetries: 2, auto: false,
    modelPolicies: [
      { provider: 'p', model: 'implicit', headroomTokens: 30_000, retainTokens: 200 },
      { provider: 'p', model: 'explicit', maxTokens: 123, compactionRetries: 4 },
      { provider: 'p', model: 'inherited' },
    ],
  }

  it('pins the same formerly implicit summary caps without changing unrelated policy', () => {
    const before = structuredClone(source)
    const next = withPressurePolicy(source, { thresholdRatio: 0.8, headroomTokens: 16_384 })
    expect(next).toEqual({
      ...source, thresholdRatio: 0.8, headroomTokens: 16_384, maxTokens: 20_000,
      modelPolicies: [
        { ...source.modelPolicies?.[0], thresholdRatio: 0.8, headroomTokens: 16_384, maxTokens: 30_000 },
        { ...source.modelPolicies?.[1], thresholdRatio: 0.8, headroomTokens: 16_384 },
        { ...source.modelPolicies?.[2], thresholdRatio: 0.8, headroomTokens: 16_384 },
      ],
    })
    expect(source).toEqual(before)
    expect(withPressurePolicy(next, { thresholdRatio: 0.8, headroomTokens: 16_384 })).toEqual(next)
    for (const target of source.modelPolicies ?? []) {
      expect(resolveTargetPolicy(resolveConfig(next), target)).toEqual({
        ...resolveTargetPolicy(resolveConfig(source), target), thresholdRatio: 0.8, headroomTokens: 16_384,
      })
    }
  })

  it('preserves each headroom and its implicit cap when headroom is omitted', () => {
    const next = withPressurePolicy(source, { thresholdRatio: 0.8 })
    expect(next).toEqual({ ...source, thresholdRatio: 0.8,
      modelPolicies: source.modelPolicies?.map(policy => ({ ...policy, thresholdRatio: 0.8 })) })
    expect(withPressurePolicy({}, { thresholdRatio: 0.8 })).toEqual({ thresholdRatio: 0.8 })
    expect(withPressurePolicy({ modelPolicies: [{ provider: 'p', model: 'inherited' }] }, { thresholdRatio: 0.8 }))
      .toEqual({ thresholdRatio: 0.8, modelPolicies: [
        { provider: 'p', model: 'inherited', thresholdRatio: 0.8 },
      ] })
    expect(withPressurePolicy({}, { thresholdRatio: 0.8, headroomTokens: 0 }))
      .toEqual({ thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 65_536 })
    expect(withPressurePolicy({ headroomTokens: 100, maxTokens: 7,
      modelPolicies: [{ provider: 'p', model: 'm', headroomTokens: 200 }] },
    { thresholdRatio: 0.8, headroomTokens: 0 })).toMatchObject({ maxTokens: 7,
      modelPolicies: [{ provider: 'p', model: 'm', headroomTokens: 0, thresholdRatio: 0.8 }] })
  })

  it('rejects merged retention conflicts before returning a candidate', () => {
    expect(() => withPressurePolicy({ retainRatio: 0.4 }, { thresholdRatio: 0.3 })).toThrow('retainRatio')
    expect(() => withPressurePolicy({}, { thresholdRatio: 0 })).toThrow('thresholdRatio')
    expect(() => withPressurePolicy({}, { thresholdRatio: 0.8, headroomTokens: -1 })).toThrow('headroomTokens')
  })

  it('commits one frozen backend config only after every known capacity fits', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const engine = new BasicCompactionEngine(ctx, source)
    const before = engine.config
    const target = { provider: 'p', model: 'implicit' }
    expect(() => engine.applyPressurePolicy({ thresholdRatio: 0.8, headroomTokens: 16_384 }, [
      { target, contextWindow: 100_000, reservedCompletionTokens: 5_000 },
      { target, contextWindow: 10_000, reservedCompletionTokens: 5_000 },
    ])).toThrow('no pressure budget')
    expect(engine.config).toBe(before)
    const next = engine.applyPressurePolicy({ thresholdRatio: 0.8, headroomTokens: 16_384 }, [
      { target, contextWindow: 100_000, reservedCompletionTokens: 5_000 },
    ])
    expect(engine.config).toBe(next)
    expect(Object.isFrozen(next)).toBe(true)
    expect(Object.isFrozen(next.modelPolicies)).toBe(true)
    expect(resolveTargetPolicy(next, target)).toEqual({
      ...resolveTargetPolicy(before, target), thresholdRatio: 0.8, headroomTokens: 16_384,
    })
  })
})
