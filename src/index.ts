import type { Context } from '@deepseek-ai/cordis'
import { mkdir, realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve as absolute, sep } from 'node:path'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@dsh-prism/dsh-workspace-registry'
import type { HostModelConfig, Layer, OrchestratorConfig, ProjectMetadata, RegistryPort, SessionRunner, ToolDefinition, TurnSpec } from './contracts.js'
import { Orchestrator } from './core.js'
import { DshSessionRunner } from './host.js'
import { PrismProvider, ProviderRouter } from './provider.js'
import type { PrismMemory, PrismTriggers } from './extensions.js'
import type { MeshPort, PeerInboxMessage, PeerMessage } from './mesh-port.js'
import type {} from './model-settings.js'

export * from './core.js'
export * from './contracts.js'
export * from './provider.js'
export { DshSessionRunner } from './host.js'

export const name = 'dsh-orchestrator'
export const inject = ['prismRegistry', 'dshMesh', 'subagents', 'agents', 'agentPresets',
  'agentDefaultModel', 'tools', 'systemPrompt', 'sessions', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry']

export type Config = (OrchestratorConfig | HostModelConfig) & { stateDirectory?: string }

interface MeshService extends MeshPort {
  runnerFor(nodeId: string): SessionRunner
  onNodesChanged?(listener: () => void): () => void
  attach(worker: {
    runner: SessionRunner
    authorize(spec: TurnSpec): TurnSpec
    definitionsFor(layer: Layer): ToolDefinition[]
    queryProjects(owner: string, search?: string): ProjectMetadata[]
    receivePeerMessage(fromNodeId: string, message: PeerMessage, signal?: AbortSignal): Promise<void>
    acceptPeerInbox(fromTargetNodeId: string, message: PeerInboxMessage): Promise<void>
    invokePeerTool(spec: TurnSpec, args: unknown, signal?: AbortSignal): Promise<unknown>
  }): () => void
}
declare module '@deepseek-ai/cordis' {
  interface Context { prism: Orchestrator }
}

function publicRegistry(registry: RegistryPort, privateRoots: string[], nodeId: string): RegistryPort {
  const contains = (parent: string, child: string) => {
    const offset = relative(parent, child)
    return !offset || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep))
  }
  const canonical = (path: string): string => {
    try { return realpathSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error }
      return absolute(path)
    }
  }
  const resolve: RegistryPort['resolve'] = (owner, projectId, mode) => {
    const project = registry.resolve(owner, projectId, mode)
    if (project.nodeId === nodeId) {
      const path = canonical(project.workspace)
      if (privateRoots.map(canonical).some(root => contains(root, path) || contains(path, root))) {
        throw new Error('此工作区为棱镜内部使用')
      }
    }
    return project
  }
  return {
    resolve,
    query: (owner, search) => registry.query(owner, search).filter(project => {
      try { resolve(owner, project.id); return true } catch { return false }
    }),
  }
}

export async function apply(ctx: Context, config: Config) {
  const mesh = ctx.get('dshMesh', true) as MeshService
  const profile = ctx.get('profileContext', true) as {dir: string} | undefined
  const profileData = profile ? join(await realpath(profile.dir), 'data', 'dsh-prism') : undefined
  const directory = config.stateDirectory ?? profileData ?? dshPath('data', 'prism')
  const privateRoot = profileData && join(profileData, 'workspace')
  const workspace = privateRoot && join(privateRoot, 'conversation')
  if (workspace) {
    await mkdir(workspace, {recursive: true, mode: 0o700})
    if (await realpath(workspace) !== workspace) {
      throw new Error('棱镜私有工作区路径已重定向')
    }
  }
  const registry = profileData ? publicRegistry(ctx.prismRegistry, [...new Set([profileData, directory])], mesh.nodeId)
    : ctx.prismRegistry
  const local = new DshSessionRunner(ctx, directory, registry)
  ctx.on('agent/created', ({agent}) => local.guardHistoryAgent(agent), { prepend: true })
  const providers = new Map<string, () => void>()
  const syncProviders = () => {
    const nodes = new Set([mesh.nodeId, ...mesh.nodeIds])
    for (const [id, dispose] of providers) {
      if (!nodes.has(id)) {
        dispose()
        providers.delete(id)
      }
    }
    for (const id of nodes) {
      if (!providers.has(id)) {
        providers.set(id, ctx.subagents.registerProvider(new PrismProvider(id, id === mesh.nodeId ? local : mesh.runnerFor(id))))
      }
    }
  }
  syncProviders()
  const unwatchNodes = mesh.onNodesChanged?.(syncProviders)
  const router = new ProviderRouter(ctx.subagents)
  const core = new Orchestrator(config, registry, router, directory, () => {
    const { provider, model } = ctx.agentDefaultModel.currentSelection()
    return { id: model, provider, description: provider }
  }, () => ctx.get('prismModelRules')?.(), workspace ? {
    workspace: {projectId: 'prism-conversation', nodeId: mesh.nodeId, cwd: workspace},
    ...(typeof mesh.queryProjects === 'function' && {mesh}),
    extensions: {
      memory: () => ctx.get('prismMemory', true) as PrismMemory | undefined,
      triggers: () => ctx.get('prismTriggers', true) as PrismTriggers | undefined,
    },
  } : undefined)
  ctx.on('settings/document-updated', ns => {
    if (ns === 'dsh-prism-models' || ns === 'agent-default-model') {
      core.refreshModels()
    }
  })
  const detach = mesh.attach({
    runner: local,
    authorize: spec => core.authorizeRemote(spec),
    definitionsFor: layer => core.remoteDefinitions(layer),
    queryProjects: (owner, search) => core.exportProjects(owner, search),
    receivePeerMessage: (from, message, signal) => core.receivePeerMessage(from, message, signal),
    acceptPeerInbox: (from, message) => core.acceptPeerInbox(from, message),
    invokePeerTool: (spec, args, signal) => core.invokePeerTool(spec, args, signal),
  })
  const close = async () => {
    unwatchNodes?.()
    for (const dispose of providers.values()) { dispose() }
    providers.clear()
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
    ctx.inject(['prismTriggers'], scope => {
      const triggers = scope.get('prismTriggers', true) as PrismTriggers
      return triggers.setSink(event => core.acceptTrigger(event))
    })
  } catch (error) {
    await close()
    throw error
  }
  return close
}
