import {randomUUID} from 'node:crypto'
import type {AgentTools, ConversationView, Layer, ModelConfig, OrchestratorConfig, ProjectMetadata, RegistryPort, SessionRunner, TraceEntry, TurnSpec} from './contracts.js'
import {modelFor, nativeExecutionTools, systemPrompt, toolSets, validateConfig} from './policy.js'
import {ConversationStore, enqueue, type Binding, type Conversation, type Job, type Task} from './store.js'

export type * from './contracts.js'

export class PrismError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND', message: string) { super(message) }
}

function textField(value: unknown, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PrismError('INVALID_INPUT', '文本为空或过长')
  return value
}

function narrow(ceiling: string[], requested: unknown): string[] {
  if (requested === undefined) return [...ceiling]
  if (!Array.isArray(requested) || requested.some(value => typeof value !== 'string' || !ceiling.includes(value))) {
    throw new PrismError('INVALID_INPUT', '请求的工具超出权限上限')
  }
  return [...new Set<string>(requested)]
}

function binding(state: Conversation, id: string): Binding {
  if (state.root.id === id) return state.root
  const task = state.tasks.find(task => task.id === id)
  if (!task) throw new PrismError('NOT_FOUND', '找不到会话')
  return task
}

function publicCatalog(models: ModelConfig[]): {id: string; description: string}[] {
  return models.map(({id, description}) => ({id, description}))
}

function now(): string { return new Date().toISOString() }
function terminal(task: Task): boolean { return task.status === 'completed' || task.status === 'failed' }

export class Orchestrator {
  private readonly store: ConversationStore
  private readonly config: OrchestratorConfig
  private readonly active = new Map<string, Promise<void>>()
  private readonly watchers = new Map<string, Set<(view: ConversationView) => void>>()
  private stopping = false

  constructor(config: OrchestratorConfig, private readonly registry: RegistryPort, private readonly runner: SessionRunner, stateDirectory: string) {
    validateConfig(config)
    this.config = structuredClone(config)
    this.store = new ConversationStore(stateDirectory)
  }

  async start(): Promise<void> {
    for (const owner of this.store.owners()) {
      this.change(owner, state => {
        // Never repeat a turn that could have already written files or sent a message.
        for (const job of [...state.queue]) {
          if (job.worker && !this.store.workerAlive(job.worker)) this.settle(state, job, false)
        }
        if (!this.config.models.L1.some(model => model.id === state.root.modelId)) {
          state.root.modelId = this.defaultModel()
        }
      })
      this.wake(owner)
    }
  }

  private defaultModel(): string { return this.config.defaultL1Model ?? this.config.models.L1[0].id }

  private newConversation(owner: string): Conversation {
    const project = this.registry.resolve(owner, this.config.defaultProjectId)
    return {
      root: {id: randomUUID(), layer: 'L1', modelId: this.defaultModel(), ceiling: [], target: {projectId: project.id, nodeId: project.nodeId, cwd: project.workspace}},
      messages: [], tasks: [], requests: [], queue: [],
    }
  }

  private change<T>(owner: string, fn: (state: Conversation) => T): T {
    textField(owner, 2048)
    return this.store.change(owner, () => this.newConversation(owner), fn)
  }

  private snapshot(state: Conversation): ConversationView {
    return {
      modelId: state.root.modelId,
      models: publicCatalog(this.config.models.L1),
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
      if (requestId) state.requests.push(requestId)
      const messageId = randomUUID()
      state.messages.push({id: messageId, role: 'user', delivery: 'pending', text, at: now()})
      enqueue(state, state.root, JSON.stringify({kind: 'user', text}), messageId)
      return this.snapshot(state)
    })
    this.publish(owner)
    this.wake(owner)
    return result
  }

  async selectModel(owner: string, modelId: string): Promise<ConversationView> {
    if (!this.config.models.L1.some(model => model.id === modelId)) throw new PrismError('INVALID_INPUT', '此交互模型不可用')
    const view = this.change(owner, state => { state.root.modelId = modelId; return this.snapshot(state) })
    this.publish(owner)
    return view
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
      if (spec.parentBindingId !== undefined || spec.workspace.projectId !== this.config.defaultProjectId) throw new Error('交互会话必须绑定默认项目')
    } else { textField(spec.parentBindingId, 256) }
    const project = this.registry.resolve(spec.owner, spec.workspace.projectId)
    if (project.nodeId !== spec.workspace.nodeId) throw new Error('项目节点不匹配')
    const model = modelFor(this.config, spec.layer, spec.model.id)
    if (!Array.isArray(spec.allowedTools)) throw new Error('缺少权限声明')
    const allowedTools = narrow(spec.layer === 'L3' ? this.ceiling(project) : [], spec.allowedTools)
    return {
      owner: spec.owner, bindingId: spec.bindingId, parentBindingId: spec.parentBindingId, layer: spec.layer,
      model: {...model}, systemPrompt: systemPrompt(spec.layer, model), allowedTools,
      ...(spec.layer === 'L2' && {delegationCeiling: narrow(this.ceiling(project), spec.delegationCeiling ?? [])}),
      workspace: {projectId: project.id, nodeId: project.nodeId, cwd: project.workspace},
    }
  }

  private spec(owner: string, actor: Binding, modelId: string, parentBindingId?: string): TurnSpec {
    if (actor.layer === 'L1' && actor.target.projectId !== this.config.defaultProjectId) throw new Error('默认项目绑定已变更')
    const project = this.registry.resolve(owner, actor.target.projectId)
    if (project.nodeId !== actor.target.nodeId || project.workspace !== actor.target.cwd) throw new Error('会话绑定的工作区已变更')
    const model = modelFor(this.config, actor.layer, modelId)
    const currentCeiling = this.ceiling(project).filter(tool => actor.ceiling.includes(tool))
    return {
      owner, bindingId: actor.id, parentBindingId, layer: actor.layer, model: {...model}, workspace: {...actor.target},
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
      return {job, actor: task ?? state.root, parent: task?.parent}
    })
    if (!claimed) return
    this.publish(owner)
    const {actor, job, parent} = claimed
    let succeeded = false
    try {
      const spec = this.spec(owner, actor, job.modelId, parent)
      const tools: AgentTools = {
        definitions: structuredClone(toolSets[actor.layer]),
        invoke: async (name, args) => {
          const result = this.change(owner, state => {
            if (!state.queue.some(item => item.id === job.id && item.worker === this.store.workerId)) throw new Error('本轮工具权限已失效')
            return this.invoke(owner, state, actor.id, name, args)
          })
          this.publish(owner)
          this.wake(owner)
          return result
        },
      }
      await this.runner.run(spec, job.text, tools)
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
    if (!task) return
    const children = state.tasks.filter(child => child.parent === task.id)
    if (!ok) task.turnFailed = true
    if (state.queue.some(item => item.bindingId === task.id) || children.some(child => !terminal(child))) return
    task.status = !task.turnFailed && children.every(child => child.status === 'completed') ? 'completed' : 'failed'
    task.at = now()
    const parent = binding(state, task.parent)
    enqueue(state, parent, JSON.stringify({kind: 'task_settled', taskId: task.id, status: task.status, progress: task.progress}))
  }

  private invoke(owner: string, state: Conversation, id: string, name: string, raw: unknown): unknown {
    const actor = binding(state, id)
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
        return {sent: true}
      }
      case 'query_projects': {
        const search = args.search === '' || args.search === undefined ? undefined : textField(args.search, 1024)
        return this.registry.query(owner, search).map(({id, description, stack, nodeId, gitRemote, permissions}) => ({
          id, description, stack, nodeId, permissions, ...(gitRemote === undefined ? {} : {gitRemote}),
        }))
      }
      case 'list_models': return publicCatalog(this.config.models[actor.layer === 'L1' ? 'L2' : 'L3'])
      case 'dispatch_planner':
      case 'dispatch_executor': return this.dispatch(owner, state, actor, args)
      case 'report_progress': {
        const task = state.tasks.find(task => task.id === id)!
        task.progress = textField(args.text)
        task.at = now()
        return {recorded: true}
      }
      case 'send_parent': {
        const task = state.tasks.find(task => task.id === id)!
        enqueue(state, binding(state, task.parent), JSON.stringify({kind: 'child_message', taskId: task.id, text: textField(args.text)}))
        return {sent: true}
      }
      case 'get_progress':
      case 'send_child': {
        const child = state.tasks.find(task => task.id === args.taskId && task.parent === id)
        if (!child) throw new PrismError('NOT_FOUND', '找不到直接子任务')
        if (name === 'get_progress') {
          const children = state.tasks.filter(task => task.parent === child.id).map(({id, title, status, progress}) => ({id, title, status, progress}))
          return {id: child.id, status: child.status, progress: child.progress, children}
        }
        if (terminal(child)) { child.status = 'queued'; child.turnFailed = false; child.at = now() }
        enqueue(state, child, JSON.stringify({kind: 'parent_message', text: textField(args.text)}))
        return {sent: true}
      }
      default: throw new Error('未知工具')
    }
  }

  private dispatch(owner: string, state: Conversation, actor: Binding, args: Record<string, unknown>): {taskId: string} {
    const layer = actor.layer === 'L1' ? 'L2' : 'L3'
    const model = modelFor(this.config, layer, textField(args.modelId, 256))
    const projectId = layer === 'L2' ? textField(args.projectId, 1024) : actor.target.projectId
    const project = this.registry.resolve(owner, projectId)
    const target = layer === 'L2' ? {projectId, nodeId: project.nodeId, cwd: project.workspace} : {...actor.target}
    if (target.nodeId !== project.nodeId || target.cwd !== project.workspace) throw new Error('项目绑定已变更')
    const ceiling = this.ceiling(project).filter(name => layer === 'L2' || actor.ceiling.includes(name))
    const task: Task = {
      id: randomUUID(), layer, target, modelId: model.id, ceiling: narrow(ceiling, args.permissions),
      parent: actor.id, title: textField(args.title, 240), progress: '', at: now(), status: 'queued',
    }
    state.tasks.push(task)
    enqueue(state, task, JSON.stringify({kind: 'assignment', text: textField(args.instruction), projectId, permissions: task.ceiling}))
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
