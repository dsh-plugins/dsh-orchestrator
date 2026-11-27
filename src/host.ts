import { createHash, randomUUID } from 'node:crypto'
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
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { copyVisibleRoot, isWorkspaceHistory, publishWorkspaceHistory, WorkspaceHistories } from './workspace-history.js'
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

export class DshSessionRunner implements SessionRunner {
  private readonly bindings: SessionBindings
  private readonly histories: WorkspaceHistories
  private readonly turns = new Map<string, Promise<void>>()
  private readonly live = new Map<string, Agent>()
  private readonly shutdown = new AbortController()
  private closing?: Promise<void>

  constructor(private readonly ctx: Context, stateDirectory: string, private readonly registry?: RegistryPort) {
    this.bindings = new SessionBindings(stateDirectory)
    this.histories = new WorkspaceHistories(ctx)
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

  /** 拒绝将历史副本或旧版已公开的真实交互会话恢复为原生可写代理。 */
  guardHistoryAgent(agent: Agent): undefined {
    const {id, origin} = agent.session.header
    if (isWorkspaceHistory(id) || this.bindings.isLegacyHistory(id) ||
      (origin === undefined && this.bindings.isWebRoot(id))) {
      throw new Error('棱镜工作区历史仅可查看')
    }
  }

  /** 从当前本机网页所有者绑定恢复工作区历史。 */
  async restoreWorkspaceHistory(spec: TurnSpec): Promise<void> {
    if (!spec.workspaceTitle) {
      return
    }
    const source = this.bindings.current(spec)
    const signal = this.shutdown.signal
    if (!source) {
      return
    }
    const current = await this.ctx.sessionPersistence.stat(source, { signal })
    if (!current) {
      return
    }
    const workspace = await this.workspaceFor(spec)
    if (current.header.origin === 'subagent') {
      await publishWorkspaceHistory(
        this.ctx, this.histories, spec, workspace, source, signal, this.bindings.legacyHistory(spec.bindingId),
      )
    } else if (spec.layer === 'L1' && !this.ctx.workspaceRegistry.archivedSessionIds.includes(source)) {
      await this.convertVisibleRoot(spec, workspace, source, signal)
    }
  }

  private async convertVisibleRoot(
    spec: TurnSpec, workspace: Workspace, original: SessionId, signal: AbortSignal,
  ): Promise<void> {
    const lease = await this.histories.open(original, signal)
    if (this.bindings.current(spec) !== original) {
      return
    }
    const digest = createHash('sha256').update(original).digest('hex')
    const hidden = SessionId('session-prism-runtime-' + digest)
    await copyVisibleRoot(this.ctx, workspace, lease, hidden, signal)
    this.bindings.convertVisibleRoot(spec, original, hidden)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.shutdown.abort(new Error('Session runner stopped'))
    this.closing = Promise.allSettled([...this.turns.values()]).then(async () => {
      try {
        await this.histories.close()
      } finally {
        this.bindings.close()
      }
    })
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
          if (this.registry && !spec.internalWorkspace) {
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

  private async readHeader(id: SessionId, signal: AbortSignal) {
    return this.ctx.sessions.get(id)?.header ?? (await this.ctx.sessionPersistence.stat(id, { signal }))?.header
  }

  private async archive(binding: string, signal: AbortSignal): Promise<void> {
    const pending = this.bindings.pending(binding)
    if (!pending.length) {
      return
    }
    const children = await Promise.all(this.bindings.childSessions(binding).map(id => this.readHeader(id, signal)))
    const parents = new Set(children.map(header => header?.parentSession))
    for (const id of pending) {
      if (!parents.has(id)) {
        await this.ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
      }
      this.bindings.archived(id)
    }
  }

  private async archivedLineage(id: SessionId | undefined, signal: AbortSignal): Promise<boolean> {
    const archived = this.ctx.workspaceRegistry.archivedSessionIds
    if (!archived.length) {
      return false
    }
    const visited = new Set<SessionId>()
    while (id !== undefined && !visited.has(id)) {
      if (archived.includes(id)) {
        return true
      }
      visited.add(id)
      const header = await this.readHeader(id, signal)
      id = header?.origin === 'subagent' ? header.parentSession : undefined
    }
    return false
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

  private async workspaceFor(spec: TurnSpec) {
    const workspaceId = this.registry && !spec.internalWorkspace
      ? resolveBinding(this.registry, spec.owner, spec.workspace).workspaceId : undefined
    const workspaces = this.ctx.workspaceRegistry
    if (spec.internalWorkspace && await realpath(spec.workspace.cwd) !== spec.workspace.cwd) {
      throw new Error('棱镜私有工作区已变更')
    }
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
    return workspace
  }

  private async activate(spec: TurnSpec, tools: AgentTools, signal: AbortSignal): Promise<AgentHandle> {
    const setup = this.setup(spec, tools)
    const workspace = await this.workspaceFor(spec)
    const workspaces = this.ctx.workspaceRegistry
    for (;;) {
      signal.throwIfAborted()
      await this.archive(spec.bindingId, signal)
      const parentSession = this.bindings.parent(spec)
      const existing = this.bindings.current(spec)
      if (existing !== undefined && workspaces.archivedSessionIds.includes(existing)) {
        throw new Error('棱镜会话已归档')
      }
      if (await this.archivedLineage(parentSession, signal)) {
        throw new Error('棱镜父会话已归档')
      }
      const header = existing === undefined ? undefined : await this.readHeader(existing, signal)
      if (existing !== undefined && header && header.origin === undefined &&
        spec.layer === 'L1' && spec.workspaceTitle) {
        await this.convertVisibleRoot(spec, workspace, existing, signal)
        continue
      }
      const previousParent = header?.parentSession
      const retiredParent = previousParent !== undefined && previousParent !== parentSession &&
        await this.archivedLineage(previousParent, signal)
      if (existing !== undefined && !retiredParent) {
        try {
          return await this.ctx.agents.resume({ resumeSessionId: existing, setup, signal })
        } catch (error) {
          if (!(error instanceof SessionAlreadyOwnedError)) throw error
        }
      }
      const options: CreateAgentOptions = {
        sessionId: SessionId('session-' + randomUUID()), setup, signal,
        meta: { cwd: workspace.path, parentSession, origin: 'subagent', agentPreset: 'prism-' + spec.layer.toLowerCase() },
      }
      const handle = existing === undefined ? await this.ctx.agents.create(options) : await this.fork(existing, options)
      let published = false
      try {
        if (existing !== undefined && workspaces.archivedSessionIds.includes(existing)) {
          throw new Error('棱镜会话已归档')
        }
        if (spec.workspaceTitle) {
          this.ctx.get('sessionTitle')?.rename(handle.agent.session, spec.workspaceTitle)
        }
        // Materialize even an empty session before publishing its logical identifier.
        await this.ctx.sessions.flush(handle.agent.session)
        await workspace.attachSession(handle.agent.session.id)
        published = this.bindings.publish(spec, existing, handle.agent.session.id, parentSession)
        if (published) {
          await this.archive(spec.bindingId, signal)
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
      try {
        await this.restoreWorkspaceHistory(spec)
      } catch (error) {
        this.ctx.logger.warn('无法更新棱镜工作区历史 %s', spec.bindingId)
        this.ctx.logger.warn(error)
      }
    }
  }
}
