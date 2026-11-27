import { messages } from './messages.js'
import {createHash, randomUUID} from 'node:crypto'
import {realpathSync} from 'node:fs'
import {dirname, join} from 'node:path'
import type {AgentTools, ConversationView, HostModelConfig, Layer, MessageSource, ModelConfig, ModelRules, OrchestratorConfig, ProjectMetadata, RegistryPort, ReplyRoute, SessionRunner, TraceEntry, TurnSpec, WorkspaceTarget} from './contracts.js'
import {externalNotificationPrompt, modelFor, nativeExecutionTools, permittedModels, remoteModelFor, resolveBinding, systemPrompt, toolSets, validateConfig} from './policy.js'
import {ConversationStore, enqueue, type Binding, type Conversation, type Job, type Task} from './store.js'
import {extensionTools, memoryQueries, toolArguments, type MediaAsset, type MediaUpload,
  type PrismExtensions, type Specialist, type TriggerEvent} from './extensions.js'
import {batchSpawn, hasMember, peerPayload, peerSend, roomLocalNode, roomPayload, type MeshPort, type PeerInboxMessage,
  type PeerMessage, type Room} from './mesh-port.js'

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

const sharedConversation = 'profile:shared'
const webOwner = 'web:owner'
const depths = {L1: 0, L2: 1, L3: 2}

/** 私有工作区与渠道的生命周期由 Cordis 宿主提供。 */
export interface ProfileConversation {
  workspace: WorkspaceTarget
  extensions?: PrismExtensions
  mesh?: MeshPort
}

export class Orchestrator {
  private readonly store: ConversationStore
  private readonly config: OrchestratorConfig | HostModelConfig
  private readonly readHostModel?: () => ModelConfig
  private readonly active = new Map<string, Promise<void>>()
  private readonly watchers = new Map<string, Set<(view: ConversationView) => void>>()
  private readonly channelAccess = new Map<string, (principal: string) => boolean>()
  private stopping = false

  constructor(config: OrchestratorConfig | HostModelConfig, private readonly registry: RegistryPort,
    private readonly runner: SessionRunner, stateDirectory: string, hostModel?: () => ModelConfig,
    private readonly readRules?: () => ModelRules | undefined, private readonly profile?: ProfileConversation) {
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
      maxDepth: this.config.maxDepth,
      models, defaultL1Model: preferred?.id,
    }
  }

  async start(): Promise<void> {
    for (const owner of this.store.owners()) {
      if (this.profile && owner !== sharedConversation) {
        continue
      }
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

  /** 读取本机网页所有者已绑定到工作区的交互及子任务历史。 */
  localWorkspaceSessions(nodeId: string): TurnSpec[] {
    const owner = this.conversationId(webOwner)
    const state = this.store.read(owner)
    if (!state) {
      return []
    }
    const config = this.currentConfig()
    const actors: (Binding | Task)[] = [...(state.previousRoots ?? []), state.root, ...state.tasks]
    return actors.flatMap(actor => {
      if (actor.target.nodeId !== nodeId) {
        return []
      }
      try {
        const modelId = actor.layer === 'L1' ? this.selectedModel(actor, config).id : actor.modelId
        return [this.spec(this.principal(state, owner, 'originId' in actor ? actor.originId : undefined),
          actor, modelId, 'parent' in actor ? actor.parent : undefined)]
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

  private requestModel(state: Conversation, owner: string, config = this.currentConfig()): ModelConfig {
    const choice = state.modelChoices?.[this.route(owner).replyTo]
    return config.models.L1.find(model => model.id === choice) ?? this.selectedModel(state.root, config)
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
    if (owner === sharedConversation && this.profile) {
      return {
        root: {id: randomUUID(), layer: 'L1', modelId: this.defaultModel(), ceiling: [],
          target: this.profile.workspace, privateWorkspace: true},
        messages: [], tasks: [], requests: [], queue: [],
      }
    }
    const projectId = this.config.defaultProjectId ?? this.registry.query(owner)[0]?.id
    return {root: this.newRoot(owner, projectId), messages: [], tasks: [], requests: [], queue: []}
  }

  private refreshRoot(owner: string, state: Conversation): void {
    if (state.root.privateWorkspace) {
      return
    }
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

  private conversationId(owner: string): string {
    textField(owner, 2048)
    return this.profile ? sharedConversation : owner
  }

  private principal(state: Conversation, owner: string, originId?: string): string {
    if (owner !== sharedConversation || !this.profile) {
      return owner
    }
    return (originId && state.origins?.[originId]?.principal) || webOwner
  }

  /** 仅渠道适配器可登记其已验证私聊的实时授权。 */
  registerChannelAccess(channelId: string, permits: (principal: string) => boolean): () => void {
    if (this.channelAccess.has(channelId)) {
      throw new Error('渠道已登记')
    }
    this.channelAccess.set(channelId, permits)
    this.wake(sharedConversation)
    return () => { this.channelAccess.delete(channelId) }
  }

  private access(owner: string): ((principal: string) => boolean) | undefined {
    try {
      const [channel] = JSON.parse(owner.slice(3)) as [string, string, string]
      return owner.startsWith('im:') ? this.channelAccess.get(channel) : undefined
    } catch {
      return undefined
    }
  }

  private permits(owner: string): boolean {
    if (!this.profile || owner === webOwner) {
      return true
    }
    return this.access(owner)?.(owner) === true
  }

  private snapshot(state: Conversation, viewer: string): ConversationView {
    const config = this.currentConfig()
    const visible = (originId?: string) => !this.profile || viewer === webOwner ||
      (originId !== undefined && state.origins?.[originId]?.principal === viewer)
    return {
      modelId: this.requestModel(state, viewer, config).id,
      models: publicCatalog(config.models.L1),
      messages: state.messages.filter(message => visible(message.originId)).map(({originId: _, ...message}) => message),
      tasks: state.tasks.filter(task => visible(task.originId)).map(task => ({
        id: task.id, title: task.layer === 'L3' ? '执行步骤' : task.title,
        status: task.status, at: task.at, ...(task.layer === 'L3' ? {parentId: task.parent} : {}),
      })),
      ...(this.profile?.extensions?.memory() && {mediaEnabled: true}),
    }
  }

  async view(owner: string): Promise<ConversationView> {
    const conversation = this.conversationId(owner)
    if (!this.permits(owner)) {
      throw new PrismError('INVALID_INPUT', '发送方未获授权')
    }
    const state = this.store.read(conversation)
    return state ? this.snapshot(state, owner) : this.change(conversation, state => this.snapshot(state, owner))
  }

  async message(owner: string, text: string, requestId?: string, source?: MessageSource,
    attachmentIds: readonly string[] = []): Promise<ConversationView> {
    if (this.stopping) throw new Error('服务正在关闭')
    if (!attachmentIds.length || text !== '') { textField(text) }
    if (attachmentIds.length > 8 || (attachmentIds.length && !this.profile?.extensions?.memory())) {
      throw new PrismError('INVALID_INPUT', '附件数量超限或记忆插件未启用')
    }
    if (requestId !== undefined) textField(requestId, 1024)
    const conversation = this.conversationId(owner)
    if (!this.permits(owner)) {
      throw new PrismError('INVALID_INPUT', '发送方未获授权')
    }
    const eventId = requestId && this.profile
      ? createHash('sha256').update(JSON.stringify([owner, requestId])).digest('base64url')
      : requestId
    const route = this.profile ? this.route(owner) : undefined
    const sender = this.profile ? (source ?? {channel: owner === webOwner ? 'web' : 'im'}) : undefined
    const current = attachmentIds.length ? this.store.read(conversation) : undefined
    if (current && eventId && current.requests.includes(eventId)) { return this.snapshot(current, owner) }
    const staged = route && current?.stagedMedia?.[route.replyTo]
    const attachments = [...new Set(attachmentIds)].map(id => {
      const key = textField(id, 128)
      if (!staged || !Object.hasOwn(staged, key)) {
        throw new PrismError('INVALID_INPUT', '附件不属于当前发送方')
      }
      return staged[key]
    })
    if (attachments.length) {
      await this.profile?.extensions?.memory()?.pinMedia?.(attachments.map(asset => asset.assetId))
      if (this.stopping || !this.permits(owner)) { throw new Error('本轮发送权限已失效') }
    }
    const result = this.change(conversation, state => {
      if (eventId && state.requests.includes(eventId)) return this.snapshot(state, owner)
      this.refreshRoot(owner, state)
      if (eventId) state.requests.push(eventId)
      const messageId = randomUUID()
      const at = now()
      if (route && sender) {
        const origins = state.origins ??= {}
        origins[messageId] = {...route, source: sender}
      }
      state.messages.push({id: messageId, role: 'user', delivery: 'pending', text, at,
        ...(sender && {source: sender, originId: messageId}),
        ...(attachments.length && {attachments})})
      if (this.readHostModel && !this.profile) {
        state.root.hostModel = this.selectedModel(state.root, this.currentConfig())
        state.root.modelId = state.root.hostModel.id
      }
      const originId = this.config.useHostModel || this.profile ? messageId : undefined
      if (originId) {
        const awaiting = state.awaitingReplies ??= {}
        awaiting[originId] = {rootId: state.root.id, plannerIds: [],
          hostModel: this.profile ? this.requestModel(state, owner) : state.root.hostModel}
      }
      enqueue(state, state.root, JSON.stringify({kind: 'user', text, ...(attachments.length && {attachments}),
        ...(route && {eventId: eventId ?? messageId, requestId: messageId, source: sender, replyTo: route.replyTo, at}),
      }), messageId, originId)
      return this.snapshot(state, owner)
    })
    this.publish(conversation)
    this.wake(conversation)
    return result
  }

  private route(principal: string): ReplyRoute {
    return {principal, replyTo: createHash('sha256').update(principal).digest('base64url')}
  }

  /** 在当前发送方的 Profile 中暂存经过格式校验的媒体。 */
  async stageMedia(owner: string, input: MediaUpload): Promise<MediaAsset> {
    const memory = this.profile?.extensions?.memory()
    if (this.stopping || !memory || !this.permits(owner)) {
      throw new PrismError('INVALID_INPUT', '附件服务不可用')
    }
    const conversation = this.conversationId(owner)
    const asset = await memory.stageMedia(input)
    if (this.stopping || !this.permits(owner)) {
      throw new PrismError('INVALID_INPUT', '发送方未获授权')
    }
    this.change(conversation, state => {
      const staged = state.stagedMedia ??= {}
      const assets = staged[this.route(owner).replyTo] ??= {}
      assets[asset.assetId] = asset
    })
    return asset
  }

  /** 只有网页所有者可以读取显示在共享时间线中的媒体原件。 */
  async readMedia(owner: string, assetId: string): Promise<(MediaAsset & {bytes: Uint8Array}) | undefined> {
    if (owner !== webOwner || !this.profile) { return undefined }
    const state = this.store.read(this.conversationId(owner))
    if (!state?.messages.some(message => message.attachments?.some(asset => asset.assetId === assetId))) {
      return undefined
    }
    return this.profile.extensions?.memory()?.readMedia(assetId)
  }

  /** 与消息投递共用 SQLite Inbox，事务提交后才确认事件。 */
  async acceptTrigger(event: TriggerEvent): Promise<void> {
    if (this.stopping || !this.profile) { throw new Error('事件 Inbox 不可用') }
    const {route} = event
    const external = event.kind === 'external.trigger'
    if (external && event.source !== 'msp') {
      throw new Error('外部事件 Provider 无效')
    }
    if (this.route(textField(route.principal, 2048)).replyTo !== route.replyTo) {
      throw new Error('事件回复目标无效')
    }
    const access = this.access(route.principal)
    if (access && !access(route.principal)) { return }
    const eventId = 'trigger:' + textField(event.eventId, 1024)
    this.change(sharedConversation, state => {
      if (state.requests.includes(eventId)) { return }
      state.requests.push(eventId)
      const id = randomUUID()
      const source = {channel: 'trigger', sender: textField(event.source, 256)}
      const at = now()
      const payload = event.payload
      const text = JSON.stringify(payload ?? null)
      textField(text)
      const origins = state.origins ??= {}
      origins[id] = {...route, source, ...(external && {trust: 'untrusted'})}
      state.messages.push({id, role: 'user', text, source, originId: id, at})
      const awaiting = state.awaitingReplies ??= {}
      awaiting[id] = {rootId: state.root.id, plannerIds: [], hostModel: this.requestModel(state, route.principal)}
      enqueue(state, state.root, JSON.stringify({
        kind: external ? 'external.trigger' : 'trigger_event',
        ...(external && {trust: 'untrusted', provider: 'msp'}),
        eventId: event.eventId, at: event.occurredAt, payload,
      }), undefined, id)
    })
    this.publish(sharedConversation)
    this.wake(sharedConversation)
  }

  async selectModel(owner: string, modelId: string): Promise<ConversationView> {
    if (!this.currentConfig().models.L1.some(model => model.id === modelId)) throw new PrismError('INVALID_INPUT', '此交互模型不可用')
    if (!this.permits(owner)) {
      throw new PrismError('INVALID_INPUT', '发送方未获授权')
    }
    const conversation = this.conversationId(owner)
    const view = this.change(conversation, state => {
      if (this.profile && owner !== webOwner) {
        const choices = state.modelChoices ??= {}
        choices[this.route(owner).replyTo] = modelId
      } else {
        state.root.modelId = modelId
      }
      return this.snapshot(state, owner)
    })
    this.publish(conversation)
    return view
  }

  /** 将模型配置变更推送到已打开的对话。 */
  refreshModels(): void {
    for (const owner of new Set([...this.watchers.keys()].map(viewer => this.conversationId(viewer)))) {
      this.publish(owner)
    }
  }

  async trace(owner: string, taskId: string): Promise<TraceEntry[]> {
    const conversation = this.conversationId(owner)
    const state = this.store.read(conversation)
    const task = state?.tasks.find(task => task.id === taskId)
    const principal = state && this.principal(state, conversation, task?.originId)
    if (!task || !principal || (principal !== owner && owner !== webOwner) || !this.permits(owner)) {
      throw new PrismError('NOT_FOUND', '找不到此任务')
    }
    if (this.profile?.mesh && task.target.nodeId !== this.profile.mesh.nodeId) {
      await this.currentProject(principal, task.target)
      return [{role: 'system', text: '请在执行节点 ' + task.target.nodeId + ' 的 DSH 工作区查看会话历史。'}]
    }
    return this.runner.transcript(this.spec(principal, task, task.modelId, task.parent))
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
    const state = this.store.read(owner)
    if (!state) {
      return
    }
    for (const [viewer, watchers] of this.watchers) {
      if ((!this.profile && viewer !== owner) || !this.permits(viewer)) {
        continue
      }
      const view = this.snapshot(state, viewer)
      for (const listener of watchers) {
        try { listener(structuredClone(view)) } catch { /* A detached channel cannot roll back a committed event. */ }
      }
    }
  }

  private ceiling(project: ProjectMetadata): string[] {
    return (this.config.executionTools ?? nativeExecutionTools).filter(name => nativeExecutionTools.includes(name) && project.permissions.includes(name))
  }

  private get maxDepth(): number {
    return this.config.maxDepth ?? 2
  }

  private async projectIndex(owner: string, search?: string): Promise<ProjectMetadata[]> {
    const projects = this.registry.query(owner, search)
    const mesh = this.profile?.mesh
    if (!mesh) { return projects }
    const remote = await Promise.allSettled(mesh.nodeIds.map(node =>
      mesh.queryProjects(node, owner, search, AbortSignal.timeout(3500))))
    const indexed = new Map(projects.filter(project => project.nodeId === mesh.nodeId)
      .map(project => [JSON.stringify([project.nodeId, project.id]), project]))
    for (const result of remote) {
      if (result.status === 'fulfilled') {
        for (const project of result.value) {
          indexed.set(JSON.stringify([project.nodeId, project.id]), project)
        }
      }
    }
    return [...indexed.values()]
  }

  private async remoteProject(owner: string, nodeId: string, projectId: string): Promise<ProjectMetadata> {
    const mesh = this.profile?.mesh
    if (!mesh || !mesh.nodeIds.includes(nodeId)) {
      throw new Error('远程项目所在节点未配置')
    }
    const projects = await mesh.queryProjects(nodeId, owner, projectId, AbortSignal.timeout(8000))
    const project = projects.find(item => item.nodeId === nodeId && item.id === projectId)
    if (!project) { throw new Error('远程项目未导出或无权访问') }
    return project
  }

  private currentProject(owner: string, target: WorkspaceTarget): Promise<ProjectMetadata> | ProjectMetadata {
    return target.discovered ? this.remoteProject(owner, target.nodeId, target.projectId)
      : resolveBinding(this.registry, owner, target)
  }

  private async dispatchProject(owner: string, args: Record<string, unknown>): Promise<ProjectMetadata | undefined> {
    const mesh = this.profile?.mesh
    if (!mesh || args.nodeId === undefined || args.nodeId === mesh.nodeId || args.nodeId === mesh.wireNodeId) { return undefined }
    return this.remoteProject(owner, textField(args.nodeId, 128), textField(args.projectId, 1024))
  }

  /** 只将工作节点显式导出的项目交给 Mesh 做对端 ACL 过滤。 */
  exportProjects(owner: string, search?: string): ProjectMetadata[] {
    const nodeId = this.profile?.workspace.nodeId
    return this.registry.query(owner, search).filter(project => {
      try { return this.registry.resolve(owner, project.id, 'configured').nodeId === nodeId } catch { return false }
    })
  }

  /** At the mesh boundary reconstruct all security-sensitive fields from worker-local configuration. */
  authorizeRemote(spec: TurnSpec): TurnSpec {
    textField(spec.owner, 2048)
    textField(spec.bindingId, 256)
    if (!['L1', 'L2', 'L3'].includes(spec.layer)) throw new Error('未知代理层级')
    const depth = depths[spec.layer]
    const granted = spec.maxDepth ?? this.maxDepth
    const maxDepth = Math.min(this.maxDepth, granted)
    if ((granted !== 1 && granted !== 2) || (spec.depth !== undefined && spec.depth !== depth) ||
      depth > maxDepth || (this.profile && spec.layer === 'L1')) {
      throw new Error('此节点的派发层级超过限制')
    }
    if (spec.room) {
      this.verifyRoom(spec.room)
      if (spec.layer !== 'L2' || !hasMember(spec.room, spec.workspace.nodeId, spec.bindingId)) {
        throw new Error('当前代理无权加入 Room')
      }
    }
    if (spec.layer === 'L1') {
      if (spec.parentBindingId !== undefined || (this.config.defaultProjectId !== undefined && spec.workspace.projectId !== this.config.defaultProjectId)) throw new Error('交互会话必须绑定默认项目')
    } else { textField(spec.parentBindingId, 256) }
    const project = this.registry.resolve(spec.owner, spec.workspace.projectId, 'configured')
    const mesh = this.profile?.mesh
    if (project.nodeId !== spec.workspace.nodeId &&
        !(mesh && project.nodeId === mesh.nodeId && spec.workspace.nodeId === mesh.wireNodeId)) {
      throw new Error('项目节点不匹配')
    }
    const model = remoteModelFor(this.currentConfig(), spec.layer, spec.model.id)
    if (!Array.isArray(spec.allowedTools)) throw new Error('缺少权限声明')
    const allowedTools = narrow(spec.layer === 'L3' ? this.ceiling(project) : [], spec.allowedTools)
    return {
      owner: spec.owner, bindingId: spec.bindingId, parentBindingId: spec.parentBindingId, layer: spec.layer,
      depth, maxDepth, ...(spec.room && {room: spec.room}),
      model: {...model}, systemPrompt: systemPrompt(spec.layer, model), allowedTools,
      ...(this.profile && {workspaceTitle: '棱镜 ' + spec.layer, showWorkspaceHistory: true}),
      ...(spec.layer === 'L2' && {delegationCeiling: narrow(this.ceiling(project), spec.delegationCeiling ?? [])}),
      workspace: {projectId: project.id, nodeId: project.nodeId, cwd: project.workspace},
    }
  }

  private spec(owner: string, actor: Binding | Task, modelId: string, parentBindingId?: string,
    hostModel = actor.hostModel, remote?: ProjectMetadata): TurnSpec {
    if (actor.layer === 'L1' && !actor.privateWorkspace && this.config.defaultProjectId !== undefined && actor.target.projectId !== this.config.defaultProjectId) throw new Error('默认项目绑定已变更')
    const project = actor.privateWorkspace ? undefined : remote ?? resolveBinding(this.registry, owner, actor.target)
    const config = this.currentConfig()
    const model = this.readHostModel
      ? hostModel ?? config.models[actor.layer].find(choice => choice.id === modelId) ?? config.models[actor.layer][0]
      : modelFor(config, actor.layer, modelId)
    const currentCeiling = project ? this.ceiling(project).filter(tool => actor.ceiling.includes(tool)) : []
    if (actor.specialist && this.specialistWorkspace(actor.specialist) !== actor.target.cwd) {
      throw new Error('专用智能体工作区已变更')
    }
    const specialistPrompt = actor.specialist === 'memory'
      ? '将原请求中值得长期保留的信息整理为完整文档。使用 memory_write 保存，保留附件引用和有依据的描述，再用 send_parent 交付文档 ID。'
      : '编写符合 @dsh-prism/dsh-triggers/protocol 的 TypeScript Provider。导出 version、initialize 和 fire。用 event_provider_publish 编译并挂载，随后用 send_parent 报告 Provider ID 和参数。'
    return {
      owner: actor.layer === 'L1' && actor.privateWorkspace ? webOwner : owner,
      bindingId: actor.id, parentBindingId, layer: actor.layer, model: {...model}, workspace: {...actor.target},
      depth: depths[actor.layer], maxDepth: Math.min(this.maxDepth, actor.maxDepth ?? this.maxDepth),
      ...(actor.room && {room: actor.room}),
      ...(actor.privateWorkspace && {internalWorkspace: true}),
      ...(this.profile && {showWorkspaceHistory: true}),
      ...((owner === webOwner || this.profile) && {
        workspaceTitle: actor.layer === 'L1' ? '棱镜' : '棱镜 ' + actor.layer + ('title' in actor ? ' · ' + actor.title : ''),
      }),
      allowedTools: actor.layer === 'L3' ? currentCeiling : [],
      ...(actor.layer === 'L2' && {delegationCeiling: currentCeiling}),
      systemPrompt: actor.specialist ? specialistPrompt : systemPrompt(actor.layer, model),
    }
  }

  private wake(owner: string): void {
    if (this.stopping) return
    const state = this.store.read(owner)
    if (!state) return
    for (const id of new Set(state.queue.map(job => job.bindingId))) {
      const job = this.nextJob(state, owner, id)
      if (this.active.has(id) || !job || job.worker) continue
      const promise = Promise.resolve().then(() => this.consume(owner, id))
        .catch(error => console.error('[dsh-prism] 无法处理会话队列', error))
        .finally(() => { this.active.delete(id); this.wake(owner) })
      this.active.set(id, promise)
    }
  }

  private nextJob(state: Conversation, owner: string, id: string): Job | undefined {
    return state.queue.find(job => {
      if (job.bindingId !== id) {
        return false
      }
      const principal = this.principal(state, owner, job.originId)
      return !!job.worker || !this.profile || principal === webOwner || this.access(principal) !== undefined
    })
  }

  private async consume(owner: string, id: string): Promise<void> {
    const claimed = this.change(owner, state => {
      const job = this.nextJob(state, owner, id)
      if (!job || job.worker) return
      job.worker = this.store.workerId
      const task = state.tasks.find(task => task.id === id)
      if (task) { task.status = 'running'; task.at = now() }
      return {job, actor: binding(state, id), parent: task?.parent,
        origin: job.originId ? state.origins?.[job.originId] : undefined}
    })
    if (!claimed) return
    this.publish(owner)
    const {actor, job, parent, origin} = claimed
    let succeeded = false
    try {
      const principal = this.principal(this.store.read(owner)!, owner, job.originId)
      if (!this.permits(principal)) {
        throw new Error('渠道授权已撤销')
      }
      const remote = actor.target.discovered ? await this.currentProject(principal, actor.target) : undefined
      const planned = this.spec(principal, actor, job.modelId, parent, job.hostModel, remote)
      const spec: TurnSpec = origin?.trust === 'untrusted' ? {
        ...planned, bindingId: job.id, isolatedNotification: true, workspaceTitle: undefined,
        showWorkspaceHistory: undefined, systemPrompt: externalNotificationPrompt,
      } : planned
      const extensions = this.profile?.extensions
      const featureTools = extensionTools(actor.layer, actor.specialist, !!extensions?.memory(),
        !!extensions?.triggers(), origin?.source.channel === 'trigger' ? false : !!origin)
      const normalTools = toolSets[actor.layer].filter(tool => {
        if (actor.specialist) { return tool.name === 'send_parent' || tool.name === 'report_progress' }
        return tool.name !== 'dispatch_executor' || spec.maxDepth! >= 2
      })
      if (actor.layer === 'L1' && this.profile?.mesh) { normalTools.push(batchSpawn) }
      if (actor.layer === 'L2' && actor.room) { normalTools.push(peerSend) }
      const definitions = job.deliveryOnly || origin?.trust === 'untrusted'
        ? toolSets.L1.filter(tool => tool.name === 'send_user')
        : [...normalTools, ...featureTools]
      const tools: AgentTools = {
        definitions: structuredClone(definitions),
        invoke: async (name, args) => {
          const values = toolArguments(definitions.find(tool => tool.name === name), args)
          const live = (state: Conversation | undefined = this.store.read(owner)) => {
            if (this.stopping || !state?.queue.some(item => item.id === job.id && item.worker === this.store.workerId) ||
              !this.permits(principal)) {
              throw new Error('本轮工具权限已失效')
            }
          }
          const state = this.store.read(owner)!
          live(state)
          if (!actor.privateWorkspace) { await this.currentProject(principal, actor.target) }
          if (name === 'query_projects') {
            const search = values.search === '' || values.search === undefined ? undefined : textField(values.search, 1024)
            const projects = await this.projectIndex(principal, search)
            live()
            return projects.map(({id, description, stack, nodeId, gitRemote, permissions}) => ({
              id, description, stack, nodeId, permissions, ...(gitRemote === undefined ? {} : {gitRemote}),
            }))
          }
          if (name === 'peer_send') {
            return this.invokePeerTool(spec, values)
          }
          if (featureTools.some(tool => tool.name === name) &&
            name !== 'spawn_memory_agent' && name !== 'spawn_event_author') {
            const result = await this.invokeExtension(state, actor, job, name, values, live)
            live()
            return result
          }
          const destination = name === 'dispatch_planner' ? await this.dispatchProject(principal, values)
            : name === 'dispatch_executor' ? remote : undefined
          const assignments = name === 'agent_spawn' ? await this.prepareBatch(principal, values) : undefined
          if (name === 'get_progress' || name === 'send_child') {
            const child = this.directChild(state, actor.id, values.taskId, job.originId)
            if (!child.privateWorkspace) { await this.currentProject(principal, child.target) }
          }
          const result = this.change(owner, state => {
            live(state)
            if (job.deliveryOnly) {
              if (name !== 'send_user') throw new Error('This delivery turn can only call send_user')
              const reply = job.originId && state.awaitingReplies?.[job.originId]
              if (!reply || reply.delivered) return {sent: true}
            }
            if (assignments) {
              return this.spawnBatch(principal, state, actor, job, assignments, values.room === true, values.max_depth)
            }
            return this.invoke(principal, state, actor.id, name, values, job, destination)
          })
          this.publish(owner)
          this.wake(owner)
          return result
        },
      }
      const input = job.deliveryOnly ? await this.finalizationText(owner, job)
        : await this.inboxText(job, this.store.read(owner)!, principal)
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

  private async finalizationText(owner: string, job: Job): Promise<string> {
    const state = this.store.read(owner)
    const reply = job.originId && state?.awaitingReplies?.[job.originId]
    const original = state?.messages.find(message => message.id === job.originId)
    if (!state || !reply || !original) throw new Error('Missing pending delivery request')
    const tasks = await Promise.all(state.tasks.filter(task => reply.plannerIds.includes(task.id)).map(async task => {
      // A grant may have changed between task completion and this last turn.
      // Reintroduce evidence only for a workspace that is still authorized.
      try {
        if (!task.privateWorkspace) {
          await this.currentProject(this.principal(state, owner, job.originId), task.target)
        }
      } catch { return undefined }
      return {id: task.id, projectId: task.target.projectId, title: task.title, status: task.status,
        result: task.finalReport ?? task.progress}
    }))
    return this.eventText(job, state, {
      kind: 'finalize_response',
      instruction: 'The delegated work has finished. Its final answer has not been delivered to the user. Call the send_user tool now with final=true, using the language and format of the specific user request below. Ordinary text is private and never delivered. Use these task results as evidence, sharing only the requested facts. If evidence is missing, explicitly send that limitation.',
      userRequest: original.text, tasks: tasks.filter(task => task !== undefined),
    })
  }

  private eventText(job: Job, state: Conversation, event = JSON.parse(job.text) as Record<string, unknown>): string {
    const origin = job.originId && state.origins?.[job.originId]
    const room = binding(state, job.bindingId).room
    return JSON.stringify(origin ? {
      eventId: job.id, requestId: job.originId, source: origin.source, replyTo: origin.replyTo, ...event,
      ...(room && {room: {id: room.id, members: room.members}}),
    } : event)
  }

  private async inboxText(job: Job, state: Conversation, principal: string): Promise<string> {
    const event = JSON.parse(job.text) as Record<string, unknown>
    if (event.kind === 'task_settled' || event.kind === 'child_message') {
      const completed = state.tasks.find(task => task.id === event.taskId)
      if (completed && !completed.privateWorkspace) {
        try {
          await this.currentProject(principal, completed.target)
        } catch {
          const safe = {kind: 'task_settled', taskId: completed.id, status: 'failed',
            result: '项目已不可访问，无法提供任务结果。'}
          return this.eventText(job, state, safe)
        }
      }
    }
    return this.eventText(job, state, event)
  }

  private settleTask(state: Conversation, task: Task, ok: boolean, originId?: string): void {
    const children = state.tasks.filter(child => child.parent === task.id)
    if (!ok) task.turnFailed = true
    if (state.queue.some(item => item.bindingId === task.id) || children.some(child => !terminal(child))) return
    task.status = !task.turnFailed && children.every(child => child.status === 'completed') ? 'completed' : 'failed'
    delete task.room
    task.at = now()
    const parent = binding(state, task.parent)
    enqueue(state, parent, JSON.stringify({
      kind: 'task_settled', taskId: task.id, title: task.title, projectId: task.target.projectId,
      status: task.status, progress: task.progress, result: task.finalReport,
    }), undefined, originId)
  }

  private invoke(owner: string, state: Conversation, id: string, name: string,
    args: Record<string, unknown>, job: Job, destination?: ProjectMetadata): unknown {
    const {originId, deliveryOnly} = job
    const actor = binding(state, id)
    if (!actor.privateWorkspace && !actor.target.discovered) {
      resolveBinding(this.registry, owner, actor.target)
    }
    switch (name) {
      case 'send_user': {
        if (args.final !== undefined && typeof args.final !== 'boolean') throw new PrismError('INVALID_INPUT', 'final 必须为布尔值')
        if (deliveryOnly && args.final === false) throw new PrismError('INVALID_INPUT', '本轮需要发送最终答复')
        const origin = originId && state.origins?.[originId]
        if (this.profile && (!origin || (args.replyTo !== undefined && args.replyTo !== origin.replyTo))) {
          throw new PrismError('INVALID_INPUT', '回复目标与原请求不匹配')
        }
        state.messages.push({id: randomUUID(), role: 'assistant', text: textField(args.text), at: now(), originId})
        const reply = originId && state.awaitingReplies?.[originId]
        if (reply && args.final !== false) {
          reply.delivered = !state.tasks.some(task => reply.plannerIds.includes(task.id) && !terminal(task))
        }
        return {sent: true}
      }
      case 'list_models': return publicCatalog(this.currentConfig().models[actor.layer === 'L1' ? 'L2' : 'L3'])
      case 'spawn_memory_agent':
      case 'spawn_event_author': return this.dispatch(owner, state, actor, args, originId,
        name === 'spawn_memory_agent' ? 'memory' : 'event')
      case 'dispatch_planner':
      case 'dispatch_executor': return this.dispatch(owner, state, actor, args, originId, undefined, destination)
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
        const child = this.directChild(state, id, args.taskId, originId)
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

  private directChild(state: Conversation, parentId: string, id: unknown, originId?: string): Task {
    const child = state.tasks.find(task => task.id === id && task.parent === parentId &&
      (!this.profile || task.originId === originId))
    if (!child) { throw new PrismError('NOT_FOUND', '找不到直接子任务') }
    return child
  }

  private specialistWorkspace(kind: Specialist): string {
    const profile = this.profile
    const plugin = kind === 'memory' ? profile?.extensions?.memory() : profile?.extensions?.triggers()
    if (!profile || !plugin) { throw new Error('专用智能体插件未启用') }
    const workspace = join(dirname(profile.workspace.cwd), kind === 'memory' ? 'memories' : 'events')
    if (realpathSync(workspace) !== workspace || realpathSync(plugin.workspace) !== workspace) {
      throw new Error('专用智能体只能使用当前 Profile 的私有工作区')
    }
    return workspace
  }

  private async invokeExtension(state: Conversation, actor: Binding, job: Job, name: string,
    args: Record<string, unknown>, authorize: () => void): Promise<unknown> {
    const origin = job.originId ? state.origins?.[job.originId] : undefined
    if (!origin) { throw new Error('本轮缺少原请求') }
    const assets = state.messages.find(message => message.id === job.originId)?.attachments ?? []
    const assetId = (id: unknown) => {
      if (!assets.some(asset => asset.assetId === id)) {
        throw new Error('附件不属于原请求')
      }
      return String(id)
    }
    const memory = this.profile?.extensions?.memory()
    const triggers = this.profile?.extensions?.triggers()
    if (name === 'memory_search' && memory) {
      const query = args.query === undefined ? undefined : textField(args.query)
      if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) ||
        args.limit < 1 || args.limit > 20)) {
        throw new Error('limit 必须是 1 至 20 的整数')
      }
      return memory.search({query, assetId: args.assetId === undefined ? undefined : assetId(args.assetId),
        limit: args.limit as number | undefined})
    }
    if (name === 'memory_get' && memory) { return (await memory.get(textField(args.documentId, 128))) ?? null }
    if (name === 'memory_write' && memory && actor.specialist === 'memory') {
      if (args.attachments !== undefined && (!Array.isArray(args.attachments) || args.attachments.length > 8)) {
        throw new Error('附件格式或数量无效')
      }
      const attachments = (args.attachments as {assetId: unknown; description?: unknown}[] | undefined)?.map(asset => ({
        assetId: assetId(asset?.assetId), description: asset?.description === undefined
          ? undefined : textField(asset.description, 4000),
      }))
      const body = args.body === '' && attachments?.length ? '' : textField(args.body, 512 * 1024)
      const input = {title: textField(args.title, 240), body, attachments}
      const key = createHash('sha256').update(JSON.stringify([actor.id, input])).digest('base64url')
      return memory.write(input, key, authorize)
    }
    if (triggers && origin.source.channel !== 'trigger') {
      if (name === 'event_add') {
        return triggers.add({providerId: textField(args.providerId, 128), params: args.params}, origin, authorize)
      }
      if (name === 'event_remove') { return {removed: await triggers.remove(textField(args.id, 128), origin, authorize)} }
      if (name === 'event_provider_publish' && actor.specialist === 'event') {
        return triggers.publish({providerId: textField(args.providerId, 128), source: textField(args.source, 128 * 1024)}, authorize)
      }
    }
    throw new Error('本轮工具权限已失效')
  }

  remoteDefinitions(layer: Layer) {
    return [...toolSets[layer], ...memoryQueries, ...(layer === 'L2' ? [peerSend] : [])]
  }

  private dispatch(owner: string, state: Conversation, actor: Binding, args: Record<string, unknown>,
    originId?: string, specialist?: Specialist, remote?: ProjectMetadata, requestedDepth?: number): {taskId: string} {
    const layer = actor.layer === 'L1' ? 'L2' : 'L3'
    const maxDepth = Math.min(this.maxDepth, actor.maxDepth ?? this.maxDepth, requestedDepth ?? this.maxDepth)
    if (depths[layer] > maxDepth) { throw new Error('派发层级超过 max_depth') }
    const model = modelFor(this.currentConfig(), layer, textField(args.modelId, 256))
    const projectId = specialist ? 'prism-' + specialist
      : layer === 'L2' ? textField(args.projectId, 1024) : actor.target.projectId
    const local = specialist || remote ? undefined : this.registry.resolve(owner, projectId)
    const project = remote ?? local
    const target: WorkspaceTarget = layer === 'L3' ? {...actor.target}
      : remote ? {projectId, nodeId: remote.nodeId, cwd: '', discovered: true}
      : local ? {projectId, nodeId: local.nodeId, cwd: local.workspace}
      : {projectId, nodeId: this.profile!.workspace.nodeId, cwd: this.specialistWorkspace(specialist!)}
    const mesh = this.profile?.mesh
    const localWireAddress = mesh && target.nodeId === mesh.nodeId && args.nodeId === mesh.wireNodeId
    if ((local && target.cwd !== local.workspace) || (project && target.nodeId !== project.nodeId) ||
      (args.nodeId !== undefined && args.nodeId !== target.nodeId && !localWireAddress)) {
      throw new Error('项目绑定已变更')
    }
    const ceiling = project ? this.ceiling(project).filter(name => layer === 'L2' || actor.ceiling.includes(name)) : []
    const task: Task = {
      id: randomUUID(), layer, target, modelId: model.id, ceiling: narrow(ceiling, args.permissions), maxDepth,
      ...(this.config.useHostModel && {hostModel: model}),
      ...(specialist && {privateWorkspace: true, specialist}),
      parent: actor.id, title: textField(args.title, 240), progress: '', at: now(), status: 'queued', originId,
    }
    state.tasks.push(task)
    const reply = originId && state.awaitingReplies?.[originId]
    if (reply && layer === 'L2') {
      reply.delivered = false
      reply.plannerIds.push(task.id)
    }
    const attachments = specialist === 'memory' ? state.messages.find(message => message.id === originId)?.attachments : undefined
    enqueue(state, task, JSON.stringify({kind: 'assignment', text: textField(args.instruction), projectId,
      permissions: task.ceiling, ...(attachments && {attachments})}), undefined, originId)
    return {taskId: task.id}
  }

  private async prepareBatch(owner: string, args: Record<string, unknown>) {
    if (!Array.isArray(args.agents) || args.agents.length < 1 || args.agents.length > 12 ||
      (args.room !== undefined && typeof args.room !== 'boolean') || (args.room && args.agents.length < 2)) {
      throw new Error('L2 批次或 Room 参数无效')
    }
    const definition = {
      parameters: (batchSpawn.parameters.properties as {agents: {items: Record<string, unknown>}}).agents.items,
      name: batchSpawn.name, description: batchSpawn.description,
    }
    return Promise.all(args.agents.map(async item => {
      const args = toolArguments(definition, item)
      return {args, project: await this.dispatchProject(owner, args)}
    }))
  }

  private spawnBatch(owner: string, state: Conversation, actor: Binding, job: Job,
    assignments: Awaited<ReturnType<Orchestrator['prepareBatch']>>, share: boolean, requestedDepth: unknown) {
    const mesh = this.profile!.mesh!
    if (requestedDepth !== undefined && ((requestedDepth !== 1 && requestedDepth !== 2) || requestedDepth > this.maxDepth)) {
      throw new Error('max_depth 超出当前配置允许的派发深度')
    }
    const assignmentsById = assignments.map(({args, project}) =>
      this.dispatch(owner, state, actor, args, job.originId, undefined, project, requestedDepth))
    const tasks = assignmentsById.map(({taskId}) => state.tasks.find(task => task.id === taskId)!)
    if (!share) { return {tasks: assignmentsById} }
    const local = tasks.some(task => task.target.nodeId !== mesh.nodeId) ? mesh.wireNodeId ?? mesh.nodeId : mesh.nodeId
    const room = {id: randomUUID(), coordinatorNode: local,
      members: tasks.map(task => ({agentId: task.id, nodeId: task.target.nodeId === mesh.nodeId ? local : task.target.nodeId}))}
    const authorized = {...room, grant: mesh.sign(roomPayload(room))}
    for (const task of tasks) { task.room = authorized }
    return {tasks: assignmentsById, room}
  }

  private verifyRoom(room: Room): MeshPort {
    const mesh = this.profile?.mesh
    if (!mesh || !mesh.verify(room.coordinatorNode, roomPayload(room), room.grant)) {
      throw new Error('Room 授权签名无效')
    }
    return mesh
  }

  /** 工作节点用本机身份签名后，经 Mesh 直发给目标节点。 */
  async invokePeerTool(spec: TurnSpec, raw: unknown, signal?: AbortSignal): Promise<{sent: boolean}> {
    if (spec.layer !== 'L2' || !spec.room) { throw new Error('未获 Room 通信授权') }
    const room = spec.room
    const mesh = this.verifyRoom(room)
    const args = toolArguments(peerSend, raw)
    const nodeId = textField(args.target_node, 128)
    const agentId = textField(args.target_agent_id, 128)
    if (!hasMember(room, roomLocalNode(mesh, room), spec.bindingId) || !hasMember(room, nodeId, agentId) ||
      agentId === spec.bindingId) {
      throw new Error('目标超出本批 L2 Room')
    }
    const message = {messageId: randomUUID(), room, senderAgentId: spec.bindingId,
      targetAgentId: agentId, text: textField(args.text)}
    const proof = mesh.sign(peerPayload(message, nodeId))
    const timeout = AbortSignal.timeout(8000)
    await mesh.peerSend({nodeId, agentId}, {messageId: message.messageId, room, senderAgentId: spec.bindingId,
      text: message.text, proof}, signal ? AbortSignal.any([signal, timeout]) : timeout)
    return {sent: true}
  }

  /** 目标节点验证直接相连的发送设备，再将收件交给持久队列。 */
  async receivePeerMessage(sourceNodeId: string, message: PeerMessage, signal?: AbortSignal): Promise<void> {
    const mesh = this.verifyRoom(message.room)
    const local = roomLocalNode(mesh, message.room)
    if (!hasMember(message.room, sourceNodeId, message.senderAgentId) ||
      !hasMember(message.room, local, message.targetAgentId) ||
      !mesh.verify(sourceNodeId, peerPayload(message, local), message.proof)) {
      throw new Error('Room 消息发送者或目标无效')
    }
    await mesh.submitPeerInbox(message.room.coordinatorNode, {...message, sourceNodeId, targetNodeId: local}, signal)
  }

  /** 协调节点以任务的原请求身份复核权限，并在确认前写入 Inbox。 */
  async acceptPeerInbox(fromTargetNodeId: string, message: PeerInboxMessage): Promise<void> {
    const {room, sourceNodeId, targetNodeId, senderAgentId, targetAgentId} = message
    const mesh = this.verifyRoom(room)
    const local = roomLocalNode(mesh, room)
    if (this.stopping || room.coordinatorNode !== local || fromTargetNodeId !== targetNodeId ||
      !hasMember(room, sourceNodeId, senderAgentId) || !hasMember(room, targetNodeId, targetAgentId) ||
      !mesh.verify(sourceNodeId, peerPayload(message, targetNodeId), message.proof)) {
      throw new Error('Room 消息发送者或目标无效')
    }
    const receipt = JSON.stringify([room.id, sourceNodeId, senderAgentId, targetNodeId, targetAgentId,
      textField(message.messageId, 128)])
    const address = (task: Task) => task.target.nodeId === mesh.nodeId ? local : task.target.nodeId
    const activeMembers = (state: Conversation) => {
      const sender = state.tasks.find(task => task.id === senderAgentId && address(task) === sourceNodeId)
      const target = state.tasks.find(task => task.id === targetAgentId && address(task) === targetNodeId)
      if (!sender || !target || sender === target || sender.layer !== 'L2' || target.layer !== 'L2' ||
        terminal(sender) || terminal(target) || sender.room?.grant !== room.grant ||
        target.room?.grant !== room.grant || sender.originId !== target.originId) {
        throw new Error('Room 成员已结束或授权已撤销')
      }
      return {sender, target}
    }
    const state = this.store.read(sharedConversation)
    if (!state) { throw new Error('Room 不存在') }
    if (state.peerReceipts?.includes(receipt)) { return }
    const {sender, target} = activeMembers(state)
    const principal = this.principal(state, sharedConversation, target.originId)
    await Promise.all([this.currentProject(principal, sender.target), this.currentProject(principal, target.target)])
    this.change(sharedConversation, state => {
      const received = state.peerReceipts ??= []
      if (received.includes(receipt)) { return }
      if (!this.permits(principal)) { throw new Error('渠道授权已撤销') }
      const current = activeMembers(state).target
      enqueue(state, current, JSON.stringify({kind: 'peer_message', senderAgentId, sourceNodeId,
        text: textField(message.text)}), undefined, current.originId)
      received.push(receipt)
    })
    this.wake(sharedConversation)
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
