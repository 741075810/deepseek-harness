/** Exercise human pressure commands against a published SDK Agent and a real profile edit. */
export const name = 'snapshot-compact-policy-control'
export const inject = ['commands', 'agentPresets']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Real composed command and preset services.
 */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession === undefined) await ctx.agentPresets.select(agent, 'first')
  })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.session.header.parentSession !== undefined) return
    const messages = JSON.stringify(agent.session.deriveMessages())
    for (const line of ['/compact-policy', '/compact-policy apply', '/compact-policy status']) {
      const result = await ctx.commands.execute(agent, line, [], signal)
      if (result?.result.kind !== 'success') throw new Error(`pressure snapshot failed: ${result?.result.text}`)
    }
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
    if (engine?.config.thresholdRatio !== 0.8 || engine.config.headroomTokens !== 16384
      || engine.config.maxTokens !== 30000 || engine.config.modelPolicies[0]?.maxTokens !== 40000) {
      throw new Error('pressure snapshot changed effective summary caps')
    }
    if (JSON.stringify(agent.session.deriveMessages()) !== messages) {
      throw new Error('pressure command changed model-visible messages')
    }
  })
}
