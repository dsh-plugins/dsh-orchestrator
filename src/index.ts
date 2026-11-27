import type { Context } from '@deepseek-ai/cordis'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@dsh-prism/dsh-workspace-registry'
import type { HostModelConfig, Layer, OrchestratorConfig, SessionRunner, ToolDefinition, TurnSpec } from './contracts.js'
import { Orchestrator } from './core.js'
import { DshSessionRunner } from './host.js'
import { PrismProvider, ProviderRouter } from './provider.js'
import { toolSets } from './policy.js'
import type {} from './model-settings.js'

export * from './core.js'
export * from './contracts.js'
export * from './provider.js'
export { DshSessionRunner } from './host.js'

export const name = 'dsh-orchestrator'
export const inject = ['prismRegistry', 'dshMesh', 'subagents', 'agents', 'agentPresets',
  'agentDefaultModel', 'tools', 'systemPrompt', 'sessions', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry']

export type Config = (OrchestratorConfig | HostModelConfig) & { stateDirectory?: string }

interface MeshService {
  nodeId: string
  nodeIds: readonly string[]
  runnerFor(nodeId: string): SessionRunner
  attach(worker: {
    runner: SessionRunner
    authorize(spec: TurnSpec): TurnSpec
    definitionsFor(layer: Layer): ToolDefinition[]
  }): () => void
}
declare module '@deepseek-ai/cordis' {
  interface Context { prism: Orchestrator }
}

export async function apply(ctx: Context, config: Config) {
  const mesh = ctx.get('dshMesh', true) as MeshService
  const directory = config.stateDirectory ?? dshPath('data', 'prism')
  const local = new DshSessionRunner(ctx, directory, ctx.prismRegistry)
  ctx.on('agent/created', ({agent}) => local.guardHistoryAgent(agent), { prepend: true })
  for (const id of [mesh.nodeId, ...mesh.nodeIds]) {
    const provider = new PrismProvider(id, id === mesh.nodeId ? local : mesh.runnerFor(id))
    ctx.subagents.registerProvider(provider)
  }
  const router = new ProviderRouter(ctx.subagents)
  const core = new Orchestrator(config, ctx.prismRegistry, router, directory, () => {
    const { provider, model } = ctx.agentDefaultModel.currentSelection()
    return { id: model, provider, description: provider }
  }, () => ctx.get('prismModelRules')?.())
  ctx.on('settings/document-updated', ns => {
    if (ns === 'dsh-prism-models' || ns === 'agent-default-model') {
      core.refreshModels()
    }
  })
  const detach = mesh.attach({ runner: local, authorize: spec => core.authorizeRemote(spec), definitionsFor: layer => toolSets[layer] })
  const close = async () => {
    router.close()
    detach()
    await Promise.all([core.close(), local.close()])
  }
  try {
    for (const spec of core.localWorkspaceSessions(mesh.nodeId)) {
      try {
        await local.restoreWorkspaceHistory(spec)
      } catch (error) {
        ctx.logger.warn('无法恢复棱镜工作区会话 %s', spec.bindingId)
        ctx.logger.warn(error)
      }
    }
    await core.start()
    ctx.provide('prism', core)
  } catch (error) {
    await close()
    throw error
  }
  return close
}
