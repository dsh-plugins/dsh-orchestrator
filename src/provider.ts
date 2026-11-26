import { randomUUID } from 'node:crypto'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentTools, SessionRunner, TurnSpec } from './contracts.js'

interface Admission {
  spec: TurnSpec
  text: string
  tools: AgentTools
}

/** A trusted dispatcher issues a single-use capability after checking owner, model,
 * destination and ceiling. A native 'spawn' prompt alone cannot choose these. */
export class PrismProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
  readonly inheritsParentContext = false
  private readonly admissions = new Map<string, Admission>()

  constructor(nodeId: string, readonly runner: SessionRunner) {
    this.name = 'prism-' + nodeId
  }

  prepare(spec: TurnSpec, text: string, tools: AgentTools) {
    const ticket = randomUUID()
    this.admissions.set(ticket, { spec, text, tools })
    return {
      prompt: [{ type: 'text' as const, text: ticket }],
      revoke: () => this.admissions.delete(ticket),
    }
  }

  // Channel ingress and durable mailbox wakes have no live parent Agent. This
  // narrower input is also accepted by the native SubagentProvider.start API.
  async start(request: Pick<ResolvedSubagentStartRequest, 'prompt' | 'signal'>): Promise<SubagentRun> {
    const part = request.prompt[0]
    const ticket = request.prompt.length === 1 && part?.type === 'text' ? part.text : ''
    const admission = this.admissions.get(ticket)
    if (!admission) throw new Error('派发凭据无效或已使用')
    this.admissions.delete(ticket)
    request.signal.throwIfAborted()
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, controller.signal])
    const ready = Promise.withResolvers<string>()
    let established = false
    const {spec, text, tools} = admission
    const result = this.runner.run(spec, text, tools, signal, id => {
      established = true
      ready.resolve(id)
    }).then<SubagentResult, SubagentResult>(
      () => {
        if (!established) ready.reject(new Error('节点未返回正式 DSH 会话 ID'))
        return { output: [], stopReason: 'completed' }
      },
      error => {
        ready.reject(error)
        if (established && !signal.aborted) console.error('[dsh-prism] DSH 会话失败', error instanceof Error ? error.message : '未知错误')
        return { output: [], stopReason: signal.aborted ? 'aborted' : 'error' }
      },
    )
    return {
      id: SessionId(await ready.promise), result,
      async dispose() {
        controller.abort()
        await result
      },
    }
  }
}

export class ProviderRouter implements SessionRunner {
  private readonly shutdown = new AbortController()

  close() { this.shutdown.abort() }

  constructor(private readonly registry: Pick<SubagentRuntime, 'getProvider'>) {}

  private resolve(spec: TurnSpec): PrismProvider {
    const provider = this.registry.getProvider('prism-' + spec.workspace.nodeId)
    if (!(provider instanceof PrismProvider)) throw new Error('项目所在的节点未配置')
    return provider
  }

  async run(spec: TurnSpec, text: string, tools: AgentTools, signal?: AbortSignal, onReady?: (id: string) => void) {
    const cancellation = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
    cancellation.throwIfAborted()
    const provider = this.resolve(spec)
    const ticket = provider.prepare(spec, text, tools)
    try {
      const run = await provider.start({ prompt: ticket.prompt, signal: cancellation })
      try {
        onReady?.(run.id)
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error('子代理会话结束：' + result.stopReason)
      } finally {
        await run.dispose()
      }
    } finally {
      ticket.revoke()
    }
  }

  transcript(spec: TurnSpec) {
    return this.resolve(spec).runner.transcript(spec)
  }
}
