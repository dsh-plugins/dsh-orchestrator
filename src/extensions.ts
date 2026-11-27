import type { Layer, ReplyRoute, ToolDefinition } from './contracts.js'

/** 媒体引用与原件分开传递，模型上下文只持有引用。 */
export interface MediaAsset {
  assetId: string
  mimeType: string
  name?: string
}

export interface MediaUpload {
  bytes: Uint8Array
  mimeType: string
  name?: string
}

/** 数据与向量索引由当前 Profile 中的记忆插件持有。 */
export interface PrismMemory {
  readonly workspace: string
  search(input: {query?: string; assetId?: string; limit?: number}): Promise<{documentId: string; fragment: string}[]>
  get(documentId: string): Promise<{
    documentId: string; title: string; body: string; attachments: (MediaAsset & {description?: string})[]
  } | undefined>
  write(input: {title: string; body: string; attachments?: {assetId: string; description?: string}[]},
    idempotencyKey: string): Promise<{documentId: string}>
  stageMedia(input: MediaUpload): Promise<MediaAsset>
  readMedia(assetId: string): Promise<(MediaAsset & {bytes: Uint8Array}) | undefined>
}

/** 只有宿主接入点可提交带原路由的持久事件。 */
export interface TriggerEvent {
  eventId: string
  source: string
  occurredAt: string
  payload: unknown
  route: ReplyRoute
}

/** 编排器绑定触发器的事件出口及用户授权。 */
export interface PrismTriggers {
  readonly workspace: string
  setSink(sink: (event: TriggerEvent) => Promise<unknown>): () => void
  add(input: {providerId: string; params: unknown}, route: ReplyRoute): Promise<unknown>
  remove(id: string, route: ReplyRoute): Promise<boolean>
  publish(input: {providerId: string; source: string}): Promise<unknown>
}

export interface PrismExtensions {
  memory(): PrismMemory | undefined
  triggers(): PrismTriggers | undefined
}

export type Specialist = 'memory' | 'event'

const string = {type: 'string'}

export function tool(name: string, description: string, properties: Record<string, unknown>,
  required: string[] = Object.keys(properties)): ToolDefinition {
  return {name, description, parameters: {type: 'object', properties, required, additionalProperties: false}}
}

export function toolArguments(definition: ToolDefinition | undefined, raw: unknown): Record<string, unknown> {
  if (!definition || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('该层无权调用此工具，或参数格式无效')
  }
  const args = raw as Record<string, unknown>
  const properties = definition.parameters.properties as Record<string, unknown>
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) ||
    (definition.parameters.required as string[]).some(key => !Object.hasOwn(args, key))) {
    throw new Error('工具参数超出声明或缺少必填项')
  }
  return args
}

export const memoryQueries = [
  tool('memory_search', '在长期记忆中语义检索。传入文本 query、本次消息的附件 assetId 或两者。仅返回命中分片和文档 ID。', {
    query: string, assetId: string, limit: {type: 'integer', minimum: 1, maximum: 20},
  }, []),
  tool('memory_get', '按 ID 读取完整记忆文档和附件引用。', {documentId: string}),
]

const specialistAssignment = {title: string, instruction: string, modelId: string}
const memorySpawn = tool('spawn_memory_agent', '派发本机记忆智能体整理并保存本次请求中的信息和附件。', specialistAssignment)
const eventSpawn = tool('spawn_event_author', '派发本机事件编写智能体创建 TypeScript 事件 Provider。', specialistAssignment)
const memoryWrite = tool('memory_write', '保存整理后的长期记忆。附件须来自原请求，并可填写描述。', {
  title: string, body: string,
  attachments: {type: 'array', items: {type: 'object', properties: {assetId: string, description: string},
    required: ['assetId'], additionalProperties: false}},
}, ['title', 'body'])
const eventPublish = tool('event_provider_publish', '编译、验证并挂载 TypeScript 事件 Provider。', {providerId: string, source: string})
const triggerTools = [
  eventSpawn,
  tool('event_add', '订阅事件 Provider。cron 参数为 expression、可选 timezone 和 payload。', {
    providerId: string, params: {type: 'object', additionalProperties: true},
  }),
  tool('event_remove', '移除当前渠道身份创建的事件订阅。', {id: string}),
]

export function extensionTools(layer: Layer, specialist: Specialist | undefined, memory: boolean,
  triggers: boolean, userOrigin: boolean): ToolDefinition[] {
  const tools = memory ? [...memoryQueries] : []
  if (layer === 'L1' && memory) { tools.push(memorySpawn) }
  if (layer === 'L1' && triggers && userOrigin) { tools.push(...triggerTools) }
  if (specialist === 'memory' && memory) { tools.push(memoryWrite) }
  if (specialist === 'event' && triggers && userOrigin) { tools.push(eventPublish) }
  return tools
}
