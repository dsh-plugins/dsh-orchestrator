import type {Layer, ModelConfig, OrchestratorConfig, ToolDefinition} from './contracts.js'

const layerPrompts: Record<Layer, string> = {
  L1: '你是棱镜的用户联络员。只有 send_user 才会将内容交付给用户。通过 query_projects 和 list_models 了解可用项目与规划模型，按项目和模型派发给 L2。通过 send_child 主动与规划代理沟通，通过 get_progress 查看进度。收到后台消息和完成事件后判断是否需要主动通知用户。将工作区和设备细节保留在内部。',
  L2: '你是棱镜的规划代理。将任务拆解成可验证的执行步骤，通过 list_models 读取模型介绍，然后通过 dispatch_executor 将步骤派发给本项目的执行代理。通过 send_parent 主动沟通计划、阻塞和最终结果。持续跟进子任务完成事件。写入 report_progress 的内容供上级查询。',
  L3: '你是棱镜的执行代理。在继承的工作区和工具权限内完成指定步骤。通过 report_progress 更新进度，并通过 send_parent 把结果或阻塞主动报告给规划代理。',
}

export const nativeExecutionTools = ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'apply_patch', 'bash']

export function modelFor(config: OrchestratorConfig, layer: Layer, id: string): ModelConfig {
  const entry = config.models[layer]?.find(model => model.id === id)
  if (!entry) throw new Error('该层未配置所选模型')
  return entry
}

export function systemPrompt(layer: Layer, model: ModelConfig): string {
  if (model.promptMode === 'replace') return model.prompt!
  return [layerPrompts[layer], model.prompt].filter(Boolean).join('\n\n')
}

export function validateConfig(config: OrchestratorConfig): void {
  if (!config.defaultProjectId?.trim()) throw new Error('需要配置默认项目')
  for (const layer of ['L1', 'L2', 'L3'] as const) {
    const models = config.models?.[layer]
    if (!Array.isArray(models) || !models.length) throw new Error(`${layer} 至少需要一个模型`)
    const seen = new Set<string>()
    for (const model of models) {
      if (typeof model?.id !== 'string' || !model.id.trim() || typeof model.description !== 'string' || !model.description.trim() || seen.has(model.id)) {
        throw new Error(`${layer} 模型需要唯一 ID 和模型介绍`)
      }
      if (model.promptMode && !['append', 'replace'].includes(model.promptMode)) throw new Error('未知的模型提示词模式')
      if (model.prompt !== undefined && typeof model.prompt !== 'string') throw new Error('模型提示词必须是文本')
      if (model.provider !== undefined && (typeof model.provider !== 'string' || !model.provider.trim())) throw new Error('模型提供方无效')
      if (model.promptMode === 'replace' && !model.prompt?.trim()) throw new Error('替换系统提示词时需要提供模型提示词')
      seen.add(model.id)
    }
  }
  if (config.defaultL1Model !== undefined) modelFor(config, 'L1', config.defaultL1Model)
  if (config.executionTools !== undefined && (!Array.isArray(config.executionTools) || config.executionTools.some(tool => !nativeExecutionTools.includes(tool)))) {
    throw new Error('执行权限中包含不支持的工具')
  }
}

const string = {type: 'string'}
const toolNames = {type: 'array', items: string}
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = Object.keys(properties)): ToolDefinition {
  return {name, description, parameters: {type: 'object', properties, required, additionalProperties: false}}
}

const models = tool('list_models', '查看下一级可选模型的 ID 和能力介绍。', {})
const progress = tool('get_progress', '查看本次派发的直接子任务的状态、进展和执行步骤。', {taskId: string})
const childMessage = tool('send_child', '主动向自己的一个直接子任务发信。', {taskId: string, text: string})
const parentMessage = tool('send_parent', '主动发信给派发此任务的上级。', {text: string})
const report = tool('report_progress', '记录供上级查询的任务进度。', {text: string})
export const toolSets: Record<Layer, ToolDefinition[]> = {
  L1: [
    tool('send_user', '向当前会话用户发送一条可见消息。', {text: string}),
    tool('query_projects', '查询授权项目的元数据。', {search: {type: 'string'}}, []),
    models,
    tool('dispatch_planner', '选择项目、规划模型和可选的后代工具权限，创建 L2 任务。', {projectId: string, modelId: string, title: string, instruction: string, permissions: toolNames}, ['projectId', 'modelId', 'title', 'instruction']),
    progress, childMessage,
  ],
  L2: [
    models,
    tool('dispatch_executor', '在当前项目中选择执行模型和可选的工具权限，创建 L3 步骤。', {modelId: string, title: string, instruction: string, permissions: toolNames}, ['modelId', 'title', 'instruction']),
    progress, childMessage, parentMessage, report,
  ],
  L3: [parentMessage, report],
}
