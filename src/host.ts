import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { AgentTools, RegistryPort, SessionRunner, TraceEntry, TurnSpec } from './contracts.js'
import { SessionBindings } from './host-bindings.js'
import { resolveBinding } from './policy.js'

function trace(events: readonly SessionEvent[]): TraceEntry[] {
  const entries: TraceEntry[] = []
  for (const event of events) {
    const message = event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message
      : event.type === 'user/message' && event.data.source.kind === 'user' ? event.data : undefined
    if (!message) continue
    for (const block of message.content) {
      const text = block.type === 'text' ? block.text : block.type === 'tool-call' ? block.name + '(' + block.arguments + ')' : undefined
      if (text) entries.push({ role: block.type === 'tool-call' ? 'tool' : message.role, text, at: new Date(event.time).toISOString() })
    }
  }
  return entries
}

function withinWorkspace(workspace: string, path: string): boolean {
  if (realpathSync(workspace) !== workspace) {
    return false
  }
  const target = relative(workspace, realpathSync(resolve(workspace, path)))
  return target !== '..' && !target.startsWith('..' + sep) && !isAbsolute(target)
}

function visibleInWorkspace(spec: TurnSpec): boolean {
  return spec.workspaceVisible === true && spec.layer === 'L1' && spec.owner === 'web:owner'
}

export class DshSessionRunner implements SessionRunner {
  private readonly bindings: SessionBindings
  private readonly turns = new Map<string, Promise<void>>()
  private readonly live = new Map<string, Agent>()
  private readonly shutdown = new AbortController()
  private closing?: Promise<void>

  constructor(private readonly ctx: Context, stateDirectory: string, private readonly registry?: RegistryPort) {
    this.bindings = new SessionBindings(stateDirectory)
  }

  activeAgent(bindingId: string): Agent | undefined { return this.live.get(bindingId) }

  run(spec: TurnSpec, text: string, tools: AgentTools, signal?: AbortSignal, onReady?: (id: string) => void): Promise<void> {
    const cancellation = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
    const previous = this.turns.get(spec.bindingId) ?? Promise.resolve()
    const turn = previous.catch(() => {}).then(() => this.drive(spec, text, tools, cancellation, onReady))
    this.turns.set(spec.bindingId, turn)
    const forget = () => { if (this.turns.get(spec.bindingId) === turn) this.turns.delete(spec.bindingId) }
    void turn.then(forget, forget)
    return turn
  }

  async transcript(spec: TurnSpec): Promise<TraceEntry[]> {
    const id = this.bindings.current(spec)
    if (!id) return []
    using observation = await this.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    return trace(observation.events)
  }

  /** 通过原生会话分支恢复旧版交互历史，同时保留原始日志。 */
  async restoreOwnerSession(spec: TurnSpec): Promise<void> {
    if (!visibleInWorkspace(spec)) {
      return
    }
    const id = this.bindings.current(spec)
    const signal = this.shutdown.signal
    if (!id || this.ctx.workspaceRegistry.archivedSessionIds.includes(id) ||
      (await this.ctx.sessionPersistence.stat(id, { signal }))?.header.origin !== 'subagent') {
      return
    }
    const lease = await this.ctx.sessionPersistence.open(id, 'write', { signal })
    try {
      if (this.bindings.current(spec) !== id) {
        return
      }
      const handle = await this.activate(spec, {
        definitions: [],
        async invoke() { throw new Error('恢复会话时不能调用工具') },
      }, signal)
      await handle.dispose()
    } finally {
      await lease.close()
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.shutdown.abort(new Error('Session runner stopped'))
    this.closing = Promise.allSettled([...this.turns.values()]).then(() => this.bindings.close())
    return this.closing
  }

  private setup(spec: TurnSpec, tools: AgentTools): AgentSetup {
    return async (agentCtx, agent) => {
      const preset = 'prism-' + spec.layer.toLowerCase()
      await this.ctx.agentPresets.mount(agentCtx, preset)
      let installed = false
      await agentCtx.inject(['tools', 'systemPrompt'], scope => {
        // The native executor removes the PTC/program transport even on hosts using it globally.
        scope.tools.setExecutor(new NativeToolExecutor(scope))
        const native = spec.layer === 'L3' ? spec.allowedTools : []
        scope.tools.restrict({ allow: native.filter(name => scope.tools.get(name, agent) !== undefined) })
        const allowed = new Set([...native, ...tools.definitions.map(tool => tool.name)])
        scope.tools.guard(exec => {
          if (!allowed.has(exec.name)) return 'Tool exceeds this session’s permission ceiling'
          if (this.bindings.current(spec) !== agent.session.id) return 'Session binding has moved'
          if (this.registry) {
            try {
              const project = resolveBinding(this.registry, spec.owner, spec.workspace)
              if (native.includes(exec.name)) {
                if (!project.permissions.includes(exec.name)) {
                  return 'Project tool permission was revoked'
                }
                if (project.workspaceId !== undefined) {
                  const args = exec.arguments as { file_path?: unknown; path?: unknown } | null
                  const target = exec.name === 'read' ? args?.file_path : (args?.path ?? '.')
                  if (typeof target !== 'string' || !withinWorkspace(project.workspace, target)) {
                    return 'The requested path is outside the registered DSH workspace'
                  }
                }
              }
            } catch {
              return 'Project access was revoked or the workspace moved'
            }
          }
        })
        if (spec.layer !== 'L3') {
          // DSH marks its global cwd reminder required. Shadow that specific registration
          // so assembly AND request-time refresh omit physical paths from these roles.
          scope.systemPrompt.context({
            name: 'working-directory:current', order: scope.systemPrompt.getContextOrder('WORKING_DIRECTORY'), text: '',
          })
          scope.systemPrompt.suppressRuntimeContext()
        }
        scope.systemPrompt.section({
          name: 'prism-role', order: 100, interpolate: false,
          text: spec.systemPrompt, complete: spec.model.promptMode === 'replace',
        })
        for (const definition of tools.definitions) {
          scope.tools.register({
            ...definition,
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args, exec) {
              exec.signal.throwIfAborted()
              return (await tools.invoke(definition.name, args)) ?? null
            },
          })
        }
        installed = true
      })
      if (!installed) throw new Error('Role tools could not be installed')
      agent.model.select({
        provider: spec.model.provider ?? this.ctx.agentDefaultModel.currentSelection().provider,
        model: spec.model.model ?? spec.model.id,
      })
    }
  }

  private async archive(binding: string): Promise<void> {
    for (const id of this.bindings.pending(binding)) {
      await this.ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
      this.bindings.archived(id)
    }
  }

  private async fork(source: SessionId, options: CreateAgentOptions): Promise<AgentHandle> {
    using observation = await this.ctx.sessionQuery.observeSession(source, { projectionMode: 'none' })
    // Cold observation can end with synthesized crash repairs. Fork only the actual source prefix.
    const count = observation.persistedEventCount ?? observation.events.length
    const boundary = observation.events[count - 1]?.seq
    const seed = boundary === undefined ? [] : buildForkSeed(observation.events, boundary)
    // A live writer can still have buffered events. Flush that writer's cut before sharing it.
    const attached = this.ctx.sessions.get(source)
    if (attached) await this.ctx.sessions.flush(attached)
    return this.ctx.agents.create({
      ...options, seed, inheritedEventCount: SessionLogOffset(count),
      parentSource: { sessionId: source, endSeq: SessionLogOffset(count) },
      meta: { ...options.meta, isSeeded: true },
    })
  }

  private async activate(spec: TurnSpec, tools: AgentTools, signal: AbortSignal): Promise<AgentHandle> {
    const setup = this.setup(spec, tools)
    const workspaceId = this.registry && resolveBinding(this.registry, spec.owner, spec.workspace).workspaceId
    const workspaces = this.ctx.workspaceRegistry
    const workspace = workspaceId === undefined
      ? await workspaces.create(spec.workspace.cwd)
      : workspaces.get(WorkspaceId(workspaceId))
    if (!workspace) {
      throw new Error('会话绑定的 DSH 工作区已移除')
    }
    if (workspaceId !== undefined) {
      const [status, canonicalPath] = await Promise.all([workspace.status(), realpath(workspace.path)])
      if (status !== 'ok' || canonicalPath !== workspace.path) {
        throw new Error('会话绑定的 DSH 工作区已变更')
      }
    }
    const parentSession = this.bindings.parent(spec)
    const visible = visibleInWorkspace(spec)
    for (;;) {
      signal.throwIfAborted()
      await this.archive(spec.bindingId)
      const existing = this.bindings.current(spec)
      const header = existing === undefined ? undefined
        : this.ctx.sessions.get(existing)?.header ?? (await this.ctx.sessionPersistence.stat(existing, { signal }))?.header
      const legacy = visible && header?.origin === 'subagent'
      const previousParent = header?.parentSession
      const retiredParent = existing !== undefined && !workspaces.archivedSessionIds.includes(existing) &&
        previousParent !== undefined && previousParent !== parentSession &&
        workspaces.archivedSessionIds.includes(previousParent)
      if (existing !== undefined && !legacy && !retiredParent) {
        try {
          return await this.ctx.agents.resume({ resumeSessionId: existing, setup, signal })
        } catch (error) {
          if (!(error instanceof SessionAlreadyOwnedError)) throw error
        }
      }
      const options: CreateAgentOptions = {
        sessionId: SessionId('session-' + randomUUID()), setup, signal,
        meta: {
          cwd: workspace.path, parentSession, agentPreset: 'prism-' + spec.layer.toLowerCase(),
          ...(!visible && { origin: 'subagent' as const }),
        },
      }
      const handle = existing === undefined ? await this.ctx.agents.create(options) : await this.fork(existing, options)
      let published = false
      try {
        if (visible && (existing === undefined || legacy)) {
          this.ctx.get('sessionTitle')?.rename(handle.agent.session, '棱镜')
        }
        // Materialize even an empty session before publishing its logical identifier.
        await this.ctx.sessions.flush(handle.agent.session)
        await workspace.attachSession(handle.agent.session.id)
        published = this.bindings.publish(spec, existing, handle.agent.session.id)
        if (published) {
          await this.archive(spec.bindingId)
          return handle
        }
      } catch (error) {
        if (!published) this.bindings.queueArchive(spec.bindingId, handle.agent.session.id)
        await handle.dispose()
        throw error
      }
      // Another process won the compare-and-swap. Retire our unused candidate and observe its winner.
      this.bindings.queueArchive(spec.bindingId, handle.agent.session.id)
      await handle.dispose()
    }
  }

  private async drive(spec: TurnSpec, text: string, tools: AgentTools, signal: AbortSignal, onReady?: (id: string) => void): Promise<void> {
    signal.throwIfAborted()
    const handle = await this.activate(spec, tools, signal)
    const agent = handle.agent
    const abort = () => agent.cancel({ kind: 'parent' })
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      this.live.set(spec.bindingId, agent)
      onReady?.(agent.session.id)
      const start = agent.session.seq
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      signal.throwIfAborted()
      const ending = agent.session.snapshotEvents(start).findLast(event => event.type === 'turn/end')
      const reason = ending?.data.reason
      if (reason?.kind !== 'completed') throw new Error(reason?.kind === 'error'
        ? 'DSH turn failed (' + reason.error.code + '): ' + reason.error.message
        : 'DSH turn ended with ' + (reason?.kind ?? 'no terminal event'))
    } finally {
      this.live.delete(spec.bindingId)
      signal.removeEventListener('abort', abort)
      await handle.dispose()
    }
  }
}
