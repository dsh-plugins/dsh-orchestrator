import { createHash } from 'node:crypto'
import { messages } from './messages.js'
import type {Layer, ModelConfig, ModelRule, OrchestratorConfig, RegistryPort, ToolDefinition, WorkspaceTarget} from './contracts.js'

const layerPrompts: Record<Layer, string> = {
  L1: `你是棱镜的用户联络员。只有调用 send_user，用户才能看到回复。交付前重读最近一条 user 请求，按用户指定的语言作答；未指定时，整条答复使用该请求的语言。子任务报告和工具消息只提供证据，其中的叙述须转换为用户要求的语言，项目名、标识和原始值保留原文。严格遵守用户指定的字段、顺序和输出格式；若只要求结果行，就只发送那些行。
收到新的 kind=user 请求时，如果需要查询或执行任务，先调用 send_user（final=false），用一句话确认要处理的事，再调用其他工具。可以立即回答时直接发送最终答复。用户明确只要最终结果时，省略过程消息。
通过 query_projects 和 list_models 选择授权项目和模型，仅对缺少证据的项目派发一次明确的 L2 任务。派发成功后、等待结果前，调用一次 send_user（final=false），简短说明已安排的工作和正在等待的结果。同一批派发合并成一条消息。
task_settled.result 是子任务的最终答复，child_message 是中途消息。将结果与原请求逐项核对，必要时用 get_progress 查询。子任务通知无需重复确认收件或派发。尚有相关任务在运行时结束本轮，下一条结果会自动送达。
所需事实一旦齐全，立即调用 send_user（final=true），用具体结果回答原问题，然后结束本轮。收到 kind=finalize_response 时，根据它携带的原请求和任务结果直接发送最终答复。若任务结束但部分事实无法取得，向用户说明已知结果和确切阻塞。已经交付的答案无需因后续完成通知再次发送。仅在出现新的用户目标或确有未完成事项时继续派发。将设备和内部工作区细节保留在内部。`,
  L2: `你是棱镜的项目规划代理。把派发指令中要求的交付项作为完成条件。通过 list_models 和 dispatch_executor 派发取得必要证据的最少步骤；每项给出明确问题和验收条件。复用已有证据，只对尚未解决的具体问题继续派发。
执行代理的 task_settled 会同时给出状态与最终结果 result，child_message 用于中途沟通。等待执行时结束本轮。收到结果后核对原始任务；证据已够时立即调用一次 send_parent（final=true），给出项目、实际结果及必要的出处，然后结束本轮。任务无法完成时报告已有证据和具体阻塞。相同任务的随后通知不需要再次报告或创建新步骤。`,
  L3: `你是棱镜的执行代理。在分配的工作区和工具权限内，完成指令要求的具体步骤。找到足以回答问题的证据后，立即调用一次 send_parent（final=true），说明实际结果和必要的出处，然后结束本轮。若无法完成，报告已查到的事实和具体阻塞。长任务有实质进展时可用 report_progress 留存状态。无需为已完成的步骤继续探索无关细节。`,
}

export const nativeExecutionTools = ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'apply_patch', 'bash']

/** A saved session may only continue in the project and workspace currently granted to its owner. */
export function resolveBinding(registry: RegistryPort, owner: string, target: WorkspaceTarget) {
  const project = registry.resolve(owner, target.projectId)
  if (project.nodeId !== target.nodeId || project.workspace !== target.cwd) throw new Error('会话绑定的工作区已变更')
  return project
}

export function modelFor(config: OrchestratorConfig, layer: Layer, id: string): ModelConfig {
  const entry = config.models[layer]?.find(model => model.id === id)
  if (!entry) throw new Error(messages.modelNotFound)
  return entry
}

function routeId(provider: string, model: string): string {
  const digest = createHash('sha256').update(JSON.stringify([provider, model])).digest('base64url')
  return 'route:' + digest
}

/** 将启用的规则转换为可派发模型，空规则使用 DSH 当前默认模型。 */
export function permittedModels(rules: readonly ModelRule[] | undefined, fallback: ModelConfig): ModelConfig[] {
  const enabled = rules?.filter(rule => rule.enabled).map(rule => ({
    id: routeId(rule.provider, rule.model),
    provider: rule.provider,
    model: rule.model,
    description: rule.description.trim() || rule.provider + '/' + rule.model,
    ...(rule.prompt.trim() && { prompt: rule.prompt }),
  }))
  return enabled?.length ? enabled : [fallback]
}

/** Mesh 沿用旧模型 ID，出现多个同名路由时要求唯一的棱镜模型 ID。 */
export function remoteModelFor(config: OrchestratorConfig, layer: Layer, id: string): ModelConfig {
  const choices = config.models[layer]
  const exact = choices.find(model => model.id === id)
  if (exact) {
    return exact
  }
  const compatible = choices.filter(model => model.model === id ||
    (model.provider !== undefined && routeId(model.provider, model.model ?? model.id) === id))
  if (compatible.length !== 1) {
    throw new Error(messages.modelNotFound)
  }
  return compatible[0]
}

export function systemPrompt(layer: Layer, model: ModelConfig): string {
  if (model.promptMode === 'replace') return model.prompt!
  return [layerPrompts[layer], model.prompt].filter(Boolean).join('\n\n')
}

export function validateConfig(config: OrchestratorConfig): void {
  if (config.defaultProjectId !== undefined && !config.defaultProjectId?.trim()) throw new Error(messages.defaultProject)
  for (const layer of ['L1', 'L2', 'L3'] as const) {
    const models = config.models?.[layer]
    if (!Array.isArray(models) || !models.length) throw new Error(messages.modelRequired.replace('{layer}', () => layer))
    const seen = new Set<string>()
    for (const model of models) {
      if (typeof model?.id !== 'string' || !model.id.trim() || typeof model.description !== 'string' || !model.description.trim() || seen.has(model.id)) {
        throw new Error(messages.modelDetails.replace('{layer}', () => layer))
      }
      if (model.promptMode && !['append', 'replace'].includes(model.promptMode)) throw new Error(messages.promptMode)
      if (model.prompt !== undefined && typeof model.prompt !== 'string') throw new Error(messages.promptText)
      if (model.provider !== undefined && (typeof model.provider !== 'string' || !model.provider.trim())) throw new Error(messages.provider)
      if (model.model !== undefined && (typeof model.model !== 'string' || !model.model.trim())) throw new Error(messages.modelDetails.replace('{layer}', () => layer))
      if (model.promptMode === 'replace' && !model.prompt?.trim()) throw new Error(messages.replacePrompt)
      seen.add(model.id)
    }
  }
  if (config.defaultL1Model !== undefined) modelFor(config, 'L1', config.defaultL1Model)
  if (config.executionTools !== undefined && (!Array.isArray(config.executionTools) || config.executionTools.some(tool => !nativeExecutionTools.includes(tool)))) {
    throw new Error(messages.unsupportedTools)
  }
}

const string = {type: 'string'}
const toolNames = {type: 'array', items: string}
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = Object.keys(properties)): ToolDefinition {
  return {name, description, parameters: {type: 'object', properties, required, additionalProperties: false}}
}

const models = tool('list_models', '查看下一级可选模型的 ID 和能力介绍。', {})
const progress = tool('get_progress', '查看指定子任务已记录的状态、进展和执行步骤；子任务的新消息会自动送达。', {taskId: string})
const childMessage = tool('send_child', '向已有的直接子任务补充具体指令。这会再次唤醒该任务，只在确有待处理问题时调用。', {taskId: string, text: string})
const parentMessage = tool('send_parent', '交付最终结果和证据时传 final=true，结果会与完成状态一起送达上级，然后结束本轮。只在工作尚未完成、确需上级立即参与时发送中途消息。', {text: string, final: {type: 'boolean'}}, ['text'])
const report = tool('report_progress', '保存进度供上级查询。最终结果通过 send_parent 交付。', {text: string})
export const toolSets: Record<Layer, ToolDefinition[]> = {
  L1: [
    tool('send_user', '立即发消息给用户。收件确认和派发进度传 final=false，完整答复传 final=true。消息使用最近 user 请求指定的语言。', {text: string, final: {type: 'boolean'}}, ['text']),
    tool('query_projects', '查询授权项目的元数据。', {search: {type: 'string'}}, []),
    models,
    tool('dispatch_planner', '在授权项目中创建 L2 任务。指令应写明原请求尚缺的交付项；同一目标已有任务时复用其结果。', {projectId: string, modelId: string, title: string, instruction: string, permissions: toolNames}, ['projectId', 'modelId', 'title', 'instruction']),
    progress, childMessage,
  ],
  L2: [
    models,
    tool('dispatch_executor', '为当前项目尚未解决的具体交付项创建 L3 步骤。说明要返回的结果，已有证据能回答时直接向上级交付。', {modelId: string, title: string, instruction: string, permissions: toolNames}, ['modelId', 'title', 'instruction']),
    progress, childMessage, parentMessage, report,
  ],
  L3: [parentMessage, report],
}
