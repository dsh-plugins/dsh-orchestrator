import type {MediaAsset} from './extensions.js'

export type Layer = 'L1' | 'L2' | 'L3'

/** DSH 模型路由在一个棱镜层级的启用状态及自定义说明。 */
export interface ModelRule {
  provider: string
  model: string
  enabled: boolean
  description: string
  prompt: string
}

/** 每个棱镜层级独立保存的模型规则。 */
export type ModelRules = Record<Layer, readonly ModelRule[]>

export interface ModelConfig {
  id: string
  provider?: string
  model?: string
  description: string
  prompt?: string
  promptMode?: 'append' | 'replace'
}

interface ProjectPolicy {
  defaultProjectId?: string
  executionTools?: string[]
}

export interface HostModelConfig extends ProjectPolicy {
  useHostModel: true
}

export interface OrchestratorConfig extends ProjectPolicy {
  useHostModel?: false
  defaultL1Model?: string
  models: Record<Layer, ModelConfig[]>
}

export interface ProjectMetadata {
  id: string
  description: string
  stack: string[]
  nodeId: string
  gitRemote?: string
  permissions: string[]
}

/** 查询会话的可见项目，Mesh 入站派发仅解析显式配置的项目。 */
export interface RegistryPort {
  query(owner: string, search?: string): ProjectMetadata[]
  resolve(owner: string, projectId: string, source?: 'configured'): ProjectMetadata & {
    workspace: string
    workspaceId?: string
  }
}

export interface WorkspaceTarget {
  projectId: string
  nodeId: string
  cwd: string
}

export interface TurnSpec {
  bindingId: string
  owner: string
  parentBindingId?: string
  layer: Layer
  /** 本机网页所有者的原生工作区会话标题。此字段不经过 Mesh。 */
  workspaceTitle?: string
  /** 仅由本机编排器标记的私有工作区。 */
  internalWorkspace?: boolean
  model: ModelConfig
  workspace: WorkspaceTarget
  /** Native DSH tools only; orchestration capabilities are supplied separately. */
  allowedTools: string[]
  /** L2 may further delegate only these native capabilities to L3. */
  delegationCeiling?: string[]
  systemPrompt: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentTools {
  definitions: ToolDefinition[]
  invoke(name: string, args: unknown): Promise<unknown>
}

export interface TraceEntry {
  role: string
  text: string
  at?: string
}

export interface SessionRunner {
  run(spec: TurnSpec, text: string, tools: AgentTools, signal?: AbortSignal, onReady?: (sessionId: string) => void): Promise<void>
  transcript(spec: TurnSpec): Promise<TraceEntry[]>
}

export interface PublicMessage {
  id: string
  role: 'user' | 'assistant'
  delivery?: 'pending' | 'processed' | 'failed'
  deliveryError?: 'no_response'
  text: string
  at: string
  source?: MessageSource
  attachments?: MediaAsset[]
}

/** 平台路由保留在宿主，模型与网页只看到发送方的展示信息。 */
export interface MessageSource {
  channel: string
  sender?: string
}

/** 事件与后续任务共同使用的已验证请求身份。 */
export interface ReplyRoute {
  principal: string
  replyTo: string
}

export interface TaskCard {
  id: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  at: string
  parentId?: string
}

export interface ConversationView {
  modelId: string
  models: {id: string; description: string; label?: string}[]
  messages: PublicMessage[]
  tasks: TaskCard[]
  mediaEnabled?: boolean
}
