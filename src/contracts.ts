export type Layer = 'L1' | 'L2' | 'L3'

export interface ModelConfig {
  id: string
  provider?: string
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
  models: {id: string; description: string}[]
  messages: PublicMessage[]
  tasks: TaskCard[]
}
