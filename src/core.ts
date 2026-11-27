import { messages } from './messages.js'
import {randomUUID} from 'node:crypto'
import type {AgentTools, ConversationView, HostModelConfig, Layer, ModelConfig, ModelRules, OrchestratorConfig, ProjectMetadata, RegistryPort, SessionRunner, TraceEntry, TurnSpec} from './contracts.js'
import {modelFor, nativeExecutionTools, permittedModels, remoteModelFor, resolveBinding, systemPrompt, toolSets, validateConfig} from './policy.js'
import {ConversationStore, enqueue, type Binding, type Conversation, type Job, type Task} from './store.js'

export type * from './contracts.js'

export class PrismError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'NO_PROJECT', message: string) { super(message) }
}

function textField(value: unknown, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PrismError('INVALID_INPUT', '文本为空或过长')
  return value
}

function narrow(ceiling: string[], requested: unknown): string[] {
  if (requested === undefined) return [...ceiling]
  if (!Array.isArray(requested) || requested.some(value => typeof value !== 'string' || !ceiling.includes(value))) {
    throw new PrismError('INVALID_INPUT', messages.ceiling)
  }
  return [...new Set<string>(requested)]
}

function binding(state: Conversation, id: string): Binding {
  if (state.root.id === id) return state.root
  const actor = state.tasks.find(task => task.id === id) ?? state.previousRoots?.find(root => root.id === id)
  if (!actor) throw new PrismError('NOT_FOUND', '找不到会话')
  return actor
}

function publicCatalog(models: ModelConfig[]): ConversationView['models'] {
  return models.map(({id, description, provider, model}) => ({
    id, description, ...(model !== undefined && provider !== undefined && {label: provider + '/' + model}),
  }))
}

function now(): string { return new Date().toISOString() }
function terminal(task: Task): boolean { return task.status === 'completed' || task.status === 'failed' }

export class Orchestrator {
  private readonly store: ConversationStore
  private readonly config: OrchestratorConfig | HostModelConfig
  private readonly readHostModel?: () => ModelConfig
  private readonly active = new Map<string, Promise<void>>()
  private readonly watchers = new Map<string, Set<(view: ConversationView) => void>>()
  private stopping = false

  constructor(config: OrchestratorConfig | HostModelConfig, private readonly registry: RegistryPort,
    private readonly runner: SessionRunner, stateDirectory: string, hostModel?: () => ModelConfig,
    private readonly readRules?: () => ModelRules | undefined) {
    this.config = structuredClone(config)
    if (config.useHostModel) {
      if (!hostModel) throw new Error('DSH default model selection is unavailable')
      this.readHostModel = hostModel
    }
    validateConfig(this.currentConfig())
    this.store = new ConversationStore(stateDirectory)
  }

  private currentConfig(): OrchestratorConfig {
    if (!this.config.useHostModel) return this.config
    const fallback = this.readHostModel!()
    const rules = this.readRules?.()
    const models = {
      L1: permittedModels(rules?.L1, fallback),
      L2: permittedModels(rules?.L2, fallback),
      L3: permittedModels(rules?.L3, fallback),
    }
    const preferred = models.L1.find(model =>
      model.provider === fallback.provider && (model.model ?? model.id) === (fallback.model ?? fallback.id))
    return {
      defaultProjectId: this.config.defaultProjectId, executionTools: this.config.executionTools,
      models, defaultL1Model: preferred?.id,
    }
  }

  async start(): Promise<void> {
    for (const owner of this.store.owners()) {
      this.change(owner, state => {
        // Never repeat a turn that could have already written files or sent a message.
        for (const job of [...state.queue]) {
          if (job.worker && !this.store.workerAlive(job.worker)) this.settle(state, job, false)
        }
        if (!this.config.useHostModel) {
          state.root.modelId = this.selectedModel(state.root, this.currentConfig()).id
        }
      })
      this.wake(owner)
    }
  }

  /** 读取本机 Web 所有者已经绑定到工作区的交互历史。 */
  localWorkspaceSessions(nodeId: string): TurnSpec[] {
    const owner = 'web:owner'
    const state = this.store.read(owner)
    if (!state) {
      return []
    }
    const config = this.currentConfig()
    return [...(state.previousRoots ?? []), state.root].flatMap(root => {
      if (root.target.nodeId !== nodeId) {
        return []
      }
      try {
        return [this.spec(owner, root, this.selectedModel(root, config).id)]
      } catch (error) {
        if (error instanceof Error) {
          console.warn('[dsh-prism] 无法恢复旧工作区会话', error.message)
          return []
        }
        throw error
      }
    })
  }

  private defaultModel(config = this.currentConfig()): string {
    return config.defaultL1Model ?? config.models.L1[0].id
  }

  private selectedModel(root: Binding, config: OrchestratorConfig): ModelConfig {
    const choices = config.models.L1
    const selected = choices.find(choice => choice.id === root.modelId)
    if (selected) {
      return selected
    }
    const old = root.hostModel
    if (old?.id === root.modelId && old.model === undefined) {
      const migrated = choices.find(choice => choice.provider === old.provider && choice.model === old.id)
      if (migrated) {
        return migrated
      }
    }
    return modelFor(config, 'L1', this.defaultModel(config))
  }

  private newRoot(owner: string, projectId?: string): Binding {
    if (projectId === undefined) throw new PrismError('NO_PROJECT', 'No authorized Prism project is available')
    const project = this.registry.resolve(owner, projectId)
    return {
      id: randomUUID(), layer: 'L1', modelId: this.defaultModel(), ceiling: [],
      target: {projectId: project.id, nodeId: project.nodeId, cwd: project.workspace},
    }
  }

  private newConversation(owner: string): Conversation {
    const projectId = this.config.defaultProjectId ?? this.registry.query(owner)[0]?.id
    return {root: this.newRoot(owner, projectId), messages: [], tasks: [], requests: [], queue: []}
  }

  private refreshRoot(owner: string, state: Conversation): void {
    if (this.config.defaultProjectId !== undefined) return
    const available = this.registry.query(owner)
    const target = state.root.target
    if (available.some(project => project.id === target.projectId)) {
      const project = this.registry.resolve(owner, target.projectId)
      if (project.nodeId === target.nodeId && project.workspace === target.cwd) return
    }
    const next = this.newRoot(owner, available[0]?.id)
    if (this.readHostModel) {
      next.modelId = state.root.modelId
    }
    // Existing jobs, agent sessions and child notifications retain the original
    // binding ID and its authorization checks, even across a host restart.
    const previous = state.previousRoots ??= []
    previous.push(state.root)
    state.root = next
  }

  private change<T>(owner: string, fn: (state: Conversation) => T): T {
    textField(owner, 2048)
    return this.store.change(owner, () => this.newConversation(owner), fn)
  }

  private snapshot(state: Conversation): ConversationView {
    const config = this.currentConfig()
    return {
      modelId: this.selectedModel(state.root, config).id,
      models: publicCatalog(config.models.L1),
      messages: state.messages,
      tasks: state.tasks.map(task => ({
        id: task.id, title: task.layer === 'L3' ? '执行步骤' : task.title,
        status: task.status, at: task.at, ...(task.layer === 'L3' ? {parentId: task.parent} : {}),
      })),
    }
  }

  async view(owner: string): Promise<ConversationView> {
    textField(owner, 2048)
    const state = this.store.read(owner)
    return state ? this.snapshot(state) : this.change(owner, state => this.snapshot(state))
  }

  async message(owner: string, text: string, requestId?: string): Promise<ConversationView> {
    if (this.stopping) throw new Error('服务正在关闭')
    textField(text)
    if (requestId !== undefined) textField(requestId, 1024)
    const result = this.change(owner, state => {
      if (requestId && state.requests.includes(requestId)) return this.snapshot(state)
      this.refreshRoot(owner, state)
      if (requestId) state.requests.push(requestId)
      const messageId = randomUUID()
      state.messages.push({id: messageId, role: 'user', delivery: 'pending', text, at: now()})
      if (this.readHostModel) {
        state.root.hostModel = this.selectedModel(state.root, this.currentConfig())
        state.root.modelId = state.root.hostModel.id
      }
      const originId = this.config.useHostModel ? messageId : undefined
      if (originId) {
        const awaiting = state.awaitingReplies ??= {}
        awaiting[originId] = {rootId: state.root.id, plannerIds: [], hostModel: state.root.hostModel}
      }
      enqueue(state, state.root, JSON.stringify({kind: 'user', text}), messageId, originId)
      return this.snapshot(state)
    })
    this.publish(owner)
    this.wake(owner)
    return result
  }

  async selectModel(owner: string, modelId: string): Promise<ConversationView> {
    if (!this.currentConfig().models.L1.some(model => model.id === modelId)) throw new PrismError('INVALID_INPUT', '此交互模型不可用')
    const view = this.change(owner, state => { state.root.modelId = modelId; return this.snapshot(state) })
    this.publish(owner)
    return view
  }

  /** 将模型配置变更推送到已打开的对话。 */
  refreshModels(): void {
    for (const owner of this.watchers.keys()) {
      this.publish(owner)
    }
  }

  async trace(owner: string, taskId: string): Promise<TraceEntry[]> {
    const task = this.store.read(textField(owner, 2048))?.tasks.find(task => task.id === taskId)
    if (!task) throw new PrismError('NOT_FOUND', '找不到此任务')
    return this.runner.transcript(this.spec(owner, task, task.modelId, task.parent))
  }

  subscribe(owner: string, listener: (view: ConversationView) => void): () => void {
    textField(owner, 2048)
    const set = this.watchers.get(owner) ?? new Set()
    this.watchers.set(owner, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (!set.size) this.watchers.delete(owner)
    }
  }

  private publish(owner: string): void {
    const watchers = this.watchers.get(owner)
    if (!watchers?.size) return
    const view = this.snapshot(this.store.read(owner)!)
    for (const listener of watchers) {
      try { listener(structuredClone(view)) } catch { /* A detached channel cannot roll back a committed event. */ }
    }
  }

  private ceiling(project: ProjectMetadata): string[] {
    return (this.config.executionTools ?? nativeExecutionTools).filter(name => nativeExecutionTools.includes(name) && project.permissions.includes(name))
  }

  /** At the mesh boundary reconstruct all security-sensitive fields from worker-local configuration. */
  authorizeRemote(spec: TurnSpec): TurnSpec {
    textField(spec.owner, 2048)
    textField(spec.bindingId, 256)
    if (!['L1', 'L2', 'L3'].includes(spec.layer)) throw new Error('未知代理层级')
    if (spec.layer === 'L1') {
      if (spec.parentBindingId !== undefined || (this.config.defaultProjectId !== undefined && spec.workspace.projectId !== this.config.defaultProjectId)) throw new Error('交互会话必须绑定默认项目')
    } else { textField(spec.parentBindingId, 256) }
    const project = this.registry.resolve(spec.owner, spec.workspace.projectId, 'configured')
    if (project.nodeId !== spec.workspace.nodeId) throw new Error('项目节点不匹配')
    const model = remoteModelFor(this.currentConfig(), spec.layer, spec.model.id)
    if (!Array.isArray(spec.allowedTools)) throw new Error('缺少权限声明')
    const allowedTools = narrow(spec.layer === 'L3' ? this.ceiling(project) : [], spec.allowedTools)
    return {
      owner: spec.owner, bindingId: spec.bindingId, parentBindingId: spec.parentBindingId, layer: spec.layer,
      model: {...model}, systemPrompt: systemPrompt(spec.layer, model), allowedTools,
      ...(spec.layer === 'L2' && {delegationCeiling: narrow(this.ceiling(project), spec.delegationCeiling ?? [])}),
      workspace: {projectId: project.id, nodeId: project.nodeId, cwd: project.workspace},
    }
  }

  private spec(owner: string, actor: Binding, modelId: string, parentBindingId?: string, hostModel = actor.hostModel): TurnSpec {
    if (actor.layer === 'L1' && this.config.defaultProjectId !== undefined && actor.target.projectId !== this.config.defaultProjectId) throw new Error('默认项目绑定已变更')
    const project = resolveBinding(this.registry, owner, actor.target)
    const config = this.currentConfig()
    const model = this.readHostModel
      ? hostModel ?? config.models[actor.layer].find(choice => choice.id === modelId) ?? config.models[actor.layer][0]
      : modelFor(config, actor.layer, modelId)
    const currentCeiling = this.ceiling(project).filter(tool => actor.ceiling.includes(tool))
    return {
      owner, bindingId: actor.id, parentBindingId, layer: actor.layer, model: {...model}, workspace: {...actor.target},
      ...(actor.layer === 'L1' && owner === 'web:owner' && {workspaceVisible: true}),
      allowedTools: actor.layer === 'L3' ? currentCeiling : [],
      ...(actor.layer === 'L2' && {delegationCeiling: currentCeiling}),
      systemPrompt: systemPrompt(actor.layer, model),
    }
  }

  private wake(owner: string): void {
    if (this.stopping) return
    const state = this.store.read(owner)
    if (!state) return
    for (const id of new Set(state.queue.map(job => job.bindingId))) {
      if (this.active.has(id) || state.queue.find(job => job.bindingId === id)?.worker) continue
      const promise = Promise.resolve().then(() => this.consume(owner, id))
        .catch(error => console.error('[dsh-prism] 无法处理会话队列', error))
        .finally(() => { this.active.delete(id); this.wake(owner) })
      this.active.set(id, promise)
    }
  }

  private async consume(owner: string, id: string): Promise<void> {
    const claimed = this.change(owner, state => {
      const job = state.queue.find(item => item.bindingId === id)
      if (!job || job.worker) return
      job.worker = this.store.workerId
      const task = state.tasks.find(task => task.id === id)
      if (task) { task.status = 'running'; task.at = now() }
      return {job, actor: binding(state, id), parent: task?.parent}
    })
    if (!claimed) return
    this.publish(owner)
    const {actor, job, parent} = claimed
    let succeeded = false
    try {
      const spec = this.spec(owner, actor, job.modelId, parent, job.hostModel)
      const tools: AgentTools = {
        definitions: structuredClone(job.deliveryOnly ? toolSets.L1.filter(tool => tool.name === 'send_user') : toolSets[actor.layer]),
        invoke: async (name, args) => {
          const result = this.change(owner, state => {
            if (!state.queue.some(item => item.id === job.id && item.worker === this.store.workerId)) throw new Error('本轮工具权限已失效')
            if (job.deliveryOnly) {
              if (name !== 'send_user') throw new Error('This delivery turn can only call send_user')
              const reply = job.originId && state.awaitingReplies?.[job.originId]
              if (!reply || reply.delivered) return {sent: true}
            }
            return this.invoke(owner, state, actor.id, name, args, job.originId)
          })
          this.publish(owner)
          this.wake(owner)
          return result
        },
      }
      const input = job.deliveryOnly ? this.finalizationText(owner, job) : job.text
      await this.runner.run(spec, input, tools)
      succeeded = true
    } catch (error) {
      console.error('[dsh-prism] 会话运行失败', error instanceof Error ? error.message : error)
    } finally {
      this.change(owner, state => this.settle(state, job, succeeded))
      this.publish(owner)
    }
  }

  private settle(state: Conversation, job: Job, ok: boolean): void {
    state.queue = state.queue.filter(item => item.id !== job.id)
    const message = job.messageId && state.messages.find(item => item.id === job.messageId)
    if (message) message.delivery = ok ? 'processed' : 'failed'
    const task = state.tasks.find(item => item.id === job.bindingId)
    if (task) this.settleTask(state, task, ok, job.originId)
    if (job.deliveryOnly && job.originId && state.awaitingReplies?.[job.originId]) {
      const original = state.messages.find(item => item.id === job.originId)
      if (original && !state.awaitingReplies[job.originId].delivered) {
        original.delivery = 'failed'
        original.deliveryError = 'no_response'
      }
      delete state.awaitingReplies[job.originId]
    }
    if (state.awaitingReplies) this.finishReplies(state)
  }

  private finishReplies(state: Conversation): void {
    for (const [originId, reply] of Object.entries(state.awaitingReplies ?? {})) {
      if (state.queue.some(job => job.originId === originId)) continue
      const planners = state.tasks.filter(task => reply.plannerIds.includes(task.id))
      if (planners.some(task => !terminal(task))) continue
      if (reply.delivered || !planners.length) {
        delete state.awaitingReplies![originId]
        continue
      }

      // This single delivery job and the receipt are committed together. A silent
      // final turn fails the original message and consumes the receipt in settle.
      enqueue(state, binding(state, reply.rootId), '{"kind":"finalize_response"}', undefined, originId).deliveryOnly = true
    }
  }

  private finalizationText(owner: string, job: Job): string {
    const state = this.store.read(owner)
    const reply = job.originId && state?.awaitingReplies?.[job.originId]
    const original = state?.messages.find(message => message.id === job.originId)
    if (!state || !reply || !original) throw new Error('Missing pending delivery request')
    const tasks = state.tasks.filter(task => reply.plannerIds.includes(task.id)).flatMap(task => {
      // A grant may have changed between task completion and this last turn.
      // Reintroduce evidence only for a workspace that is still authorized.
      try { resolveBinding(this.registry, owner, task.target) } catch { return [] }
      return [{id: task.id, projectId: task.target.projectId, title: task.title, status: task.status,
        result: task.finalReport ?? task.progress}]
    })
    return JSON.stringify({
      kind: 'finalize_response',
      instruction: 'The delegated work has finished. Its final answer has not been delivered to the user. Call the send_user tool now, using the language and format of the specific user request below. Ordinary text is private and never delivered. Use these task results as evidence, sharing only the requested facts. If evidence is missing, explicitly send that limitation.',
      userRequest: original.text, tasks,
    })
  }

  private settleTask(state: Conversation, task: Task, ok: boolean, originId?: string): void {
    const children = state.tasks.filter(child => child.parent === task.id)
    if (!ok) task.turnFailed = true
    if (state.queue.some(item => item.bindingId === task.id) || children.some(child => !terminal(child))) return
    task.status = !task.turnFailed && children.every(child => child.status === 'completed') ? 'completed' : 'failed'
    task.at = now()
    const parent = binding(state, task.parent)
    enqueue(state, parent, JSON.stringify({
      kind: 'task_settled', taskId: task.id, title: task.title, projectId: task.target.projectId,
      status: task.status, progress: task.progress, result: task.finalReport,
    }), undefined, originId)
  }

  private invoke(owner: string, state: Conversation, id: string, name: string, raw: unknown, originId?: string): unknown {
    const actor = binding(state, id)
    resolveBinding(this.registry, owner, actor.target)
    const definition = toolSets[actor.layer].find(tool => tool.name === name)
    if (!definition || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('该层无权调用此工具，或参数格式无效')
    const args = raw as Record<string, unknown>
    const schema = definition.parameters
    const properties = schema.properties as Record<string, unknown>
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) || (schema.required as string[]).some(key => !Object.hasOwn(args, key))) {
      throw new Error('工具参数超出声明或缺少必填项')
    }
    switch (name) {
      case 'send_user': {
        state.messages.push({id: randomUUID(), role: 'assistant', text: textField(args.text), at: now()})
        const reply = originId && state.awaitingReplies?.[originId]
        if (reply) reply.delivered = !state.tasks.some(task => reply.plannerIds.includes(task.id) && !terminal(task))
        return {sent: true}
      }
      case 'query_projects': {
        const search = args.search === '' || args.search === undefined ? undefined : textField(args.search, 1024)
        return this.registry.query(owner, search).map(({id, description, stack, nodeId, gitRemote, permissions}) => ({
          id, description, stack, nodeId, permissions, ...(gitRemote === undefined ? {} : {gitRemote}),
        }))
      }
      case 'list_models': return publicCatalog(this.currentConfig().models[actor.layer === 'L1' ? 'L2' : 'L3'])
      case 'dispatch_planner':
      case 'dispatch_executor': return this.dispatch(owner, state, actor, args, originId)
      case 'report_progress': {
        const task = state.tasks.find(task => task.id === id)!
        task.progress = textField(args.text)
        task.at = now()
        return {recorded: true}
      }
      case 'send_parent': {
        const task = state.tasks.find(task => task.id === id)!
        const text = textField(args.text)
        if (args.final !== undefined && typeof args.final !== 'boolean') throw new PrismError('INVALID_INPUT', 'final 必须为布尔值')
        if (args.final) {
          if (state.tasks.some(child => child.parent === id && !terminal(child))) {
            throw new PrismError('INVALID_INPUT', '等待仍在运行的子任务完成后提交最终结果')
          }
          task.finalReport = text
          return {recorded: true, delivery: 'task_settled'}
        }
        enqueue(state, binding(state, task.parent), JSON.stringify({kind: 'child_message', taskId: task.id, text}), undefined, originId)
        return {sent: true}
      }
      case 'get_progress':
      case 'send_child': {
        const child = state.tasks.find(task => task.id === args.taskId && task.parent === id)
        if (!child) throw new PrismError('NOT_FOUND', '找不到直接子任务')
        if (name === 'get_progress') {
          const children = state.tasks.filter(task => task.parent === child.id).map(({id, title, status, progress}) => ({id, title, status, progress}))
          return {
            id: child.id, status: child.status, progress: child.progress, children,
            ...(child.finalReport === undefined ? {} : {result: child.finalReport}),
          }
        }
        if (terminal(child)) { child.status = 'queued'; child.turnFailed = false; child.at = now() }
        delete child.finalReport
        const reply = originId && state.awaitingReplies?.[originId]
        if (reply && actor.layer === 'L1') {
          reply.delivered = false
          if (!reply.plannerIds.includes(child.id)) reply.plannerIds.push(child.id)
        }
        enqueue(state, child, JSON.stringify({kind: 'parent_message', text: textField(args.text)}), undefined, originId)
        return {sent: true}
      }
      default: throw new Error('未知工具')
    }
  }

  private dispatch(owner: string, state: Conversation, actor: Binding, args: Record<string, unknown>, originId?: string): {taskId: string} {
    const layer = actor.layer === 'L1' ? 'L2' : 'L3'
    const model = modelFor(this.currentConfig(), layer, textField(args.modelId, 256))
    const projectId = layer === 'L2' ? textField(args.projectId, 1024) : actor.target.projectId
    const project = this.registry.resolve(owner, projectId)
    const target = layer === 'L2' ? {projectId, nodeId: project.nodeId, cwd: project.workspace} : {...actor.target}
    if (target.nodeId !== project.nodeId || target.cwd !== project.workspace) throw new Error('项目绑定已变更')
    const ceiling = this.ceiling(project).filter(name => layer === 'L2' || actor.ceiling.includes(name))
    const task: Task = {
      id: randomUUID(), layer, target, modelId: model.id, ceiling: narrow(ceiling, args.permissions),
      ...(this.config.useHostModel && {hostModel: model}),
      parent: actor.id, title: textField(args.title, 240), progress: '', at: now(), status: 'queued',
    }
    state.tasks.push(task)
    const reply = originId && state.awaitingReplies?.[originId]
    if (reply && layer === 'L2') {
      reply.delivered = false
      reply.plannerIds.push(task.id)
    }
    enqueue(state, task, JSON.stringify({kind: 'assignment', text: textField(args.instruction), projectId, permissions: task.ceiling}), undefined, originId)
    return {taskId: task.id}
  }

  /** Wait for all in-process work, including events enqueued by completing agents. */
  async whenIdle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()])
  }

  /** Stop claiming new turns; committed outstanding messages remain available on restart. */
  async close(): Promise<void> {
    this.stopping = true
    await this.whenIdle()
    this.watchers.clear()
    this.store.close()
  }
}
