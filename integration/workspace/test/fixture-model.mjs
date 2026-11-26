// Deterministic DSH adapter for the integration test. All outputs take the real agent loop,
// tool executor, session log, provider and channel paths. It never contacts an API.
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'prism-integration-test-model'
export const inject = ['llm']
export const privateText = '普通模型输出只应出现在底层会话。'
export const explicitText = '已将请求派发给规划代理。'
export const completeText = '规划任务已完成。'

function textOf(message) {
  return message?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
}

function toolSteps(model, input, exchanges, parallelBranches) {
  if (model === 'flash' && input.kind === 'user') {
    const child = exchanges.find(pair => pair.name === 'dispatch_planner')?.result
    const taskId = child && JSON.parse(child).taskId
    return [
      ['query_projects', {}], ['list_models', {}],
      ['dispatch_planner', { projectId: 'code', modelId: 'plan', title: '检查项目', instruction: '拆解检查步骤', permissions: ['read'] }],
      ['get_progress', { taskId }], ['send_child', { taskId, text: '请主动汇报进度' }],
      ['send_user', { text: explicitText }],
    ]
  }
  if (model === 'flash' && input.kind === 'task_settled') return [['send_user', { text: completeText }]]
  if (model === 'plan' && input.kind === 'assignment') return [
    ['list_models', {}], ['report_progress', { text: '已开始规划' }],
    ['dispatch_executor', { modelId: 'exec', title: '读取材料', instruction: '读取本项目的验证材料' }],
    ...(parallelBranches ? [['dispatch_executor', { modelId: 'exec', title: '独立复核', instruction: '复核验证材料' }]] : []),
    ['send_parent', { text: '已派发读取步骤' }],
  ]
  if (model === 'exec' && input.kind === 'assignment') return [
    ['read', { file_path: 'probe.txt' }], ['report_progress', { text: '已读取材料' }],
    ['send_parent', { text: '读取完成' }],
  ]
  return []
}

class ProbeModel extends LlmAdapter {
  concurrentExecutors = new Set()
  bothStarted = Promise.withResolvers()
  constructor(config) { super(); this.config = config }

  async meetOtherBranch(sessionId) {
    this.concurrentExecutors.add(sessionId)
    if (this.concurrentExecutors.size >= 2) this.bothStarted.resolve()
    let timer
    try {
      await Promise.race([this.bothStarted.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('parallel executor did not start')), 15_000)
      })])
    } finally { clearTimeout(timer) }
  }
  async listModels(provider) {
    return ['flash', 'alternative', 'plan', 'exec'].map(id => ({ provider, id, name: id }))
  }
  async *stream(options) {
    options.signal?.throwIfAborted()
    const lastUser = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
    const input = JSON.parse(textOf(options.messages[lastUser]))
    const current = options.messages.slice(lastUser + 1)
    const calls = current.flatMap(message => message.role === 'assistant' ? message.content.filter(block => block.type === 'tool-call') : [])
    const exchanges = calls.map(call => {
      const result = current.find(message => message.role === 'tool' && message.toolCallId === call.id)
      return { name: call.name, result: textOf(result), isError: result?.isError ?? false }
    })
    if (this.config.parallelBranches && options.model === 'exec' && input.kind === 'assignment' && !calls.length) {
      await this.meetOtherBranch(options.sessionId)
    }
    const step = toolSteps(options.model, input, exchanges, this.config.parallelBranches)[calls.length]
    await appendFile(this.config.logFile, JSON.stringify({
      model: options.model, session: options.sessionId, input: input.kind,
      tools: options.tools?.map(tool => tool.name), system: options.messages.filter(message => message.role === 'system').map(textOf).join('\n'),
      runtimeContext: options.messages.filter(message => message.source?.kind === 'runtime-context').map(textOf),
      inputText: options.model === 'exec' ? undefined : options.messages.map(textOf).join('\n'),
      exchange: exchanges.at(-1),
    }) + '\n')
    if (step) {
      const [name, args] = step
      const id = randomUUID()
      const json = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: privateText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: privateText } }
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: step ? 'tool-calls' : 'stop' } }
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter(['prism-probe'], new ProbeModel(config))
}
