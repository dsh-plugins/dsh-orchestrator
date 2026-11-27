import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader, type SessionId as Id } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type { TurnSpec } from './contracts.js'

const historyPrefix = 'session-prism-history-'

/** 判断会话是否为棱镜工作区的只读记录。 */
export function isWorkspaceHistory(id: Id): boolean {
  return id.startsWith(historyPrefix)
}

/** 保留展示会话的写租约，使原生客户端只能取得读取句柄。 */
export class WorkspaceHistories {
  private readonly writers = new Map<Id, Promise<SessionHandle>>()

  constructor(private readonly ctx: Context) {}

  open(id: Id, signal: AbortSignal, header?: SessionHeader): Promise<SessionHandle> {
    const existing = this.writers.get(id)
    if (existing) {
      return existing
    }
    const persistence = this.ctx.sessionPersistence
    const pending = (header ? persistence.create(header, { signal }) : persistence.open(id, 'write', { signal }))
      .catch(error => {
        this.writers.delete(id)
        throw error
      })
    this.writers.set(id, pending)
    return pending
  }

  async close(): Promise<void> {
    const writers = [...this.writers.values()]
    this.writers.clear()
    const results = await Promise.allSettled(writers.map(async writer => {
      const handle = await writer
      await handle.close()
    }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) {
      throw new AggregateError(errors, '关闭棱镜工作区历史失败')
    }
  }
}

function withoutInheritedMarker(event: SessionEvent): SessionEvent {
  if (event.type === 'session/end-seed' && event.data.inherited === true) {
    return { ...event, data: {} }
  }
  return event
}

function historyEvent(event: SessionEvent, title: string): SessionEvent {
  if (event.type === 'session/title') {
    return { ...event, data: { title, messageSeqs: [], source: { kind: 'user' } } }
  }
  return withoutInheritedMarker(event)
}

async function appendHistory(
  output: SessionHandle, latest: readonly SessionEvent[], signal: AbortSignal,
  source: readonly SessionEvent[] = latest,
): Promise<boolean> {
  const { events } = await output.read(0, undefined, { signal })
  const last = events.at(-1)
  const expected = source[events.length - 1]
  if (events.length > source.length ||
    (last && expected && !isDeepStrictEqual(withoutInheritedMarker(last), withoutInheritedMarker(expected)))) {
    throw new Error('棱镜工作区历史与正式会话的记录前缀不一致')
  }
  const append = latest.slice(events.length)
  if (append.length === 0) {
    return false
  }
  await output.append(append, { signal })
  await output.flush({ signal })
  return true
}

/** 平铺旧版公开执行会话的事件，供新的私有执行载体接续。 */
export async function copyVisibleRoot(
  ctx: Context, workspace: Workspace, original: SessionHandle, hidden: Id, signal: AbortSignal,
): Promise<void> {
  if (original.header.cwd !== workspace.path) {
    throw new Error('棱镜执行会话目录已变更')
  }
  const { events } = await original.read(0, undefined, { signal })
  const persistence = ctx.sessionPersistence
  const existing = await persistence.stat(hidden, { signal })
  const header = existing?.header ?? ctx.sessions.prepare(hidden, {
    meta: {
      cwd: workspace.path, createdAt: original.header.createdAt,
      origin: 'subagent', agentPreset: original.header.agentPreset,
    },
  }).header
  await using output = existing ? await persistence.open(hidden, 'write', { signal }) : await persistence.create(header, { signal })
  if (!await appendHistory(output, events.map(withoutInheritedMarker), signal)) {
    await output.flush({ signal })
  }
  await workspace.attachSession(hidden)
}

export function visibleWorkspaceTitle(spec: TurnSpec): string | undefined {
  return spec.owner === 'web:owner' || spec.showWorkspaceHistory ? spec.workspaceTitle : undefined
}

/** 将已结算的正式会话记录追加到同一个原生工作区会话。 */
export async function publishWorkspaceHistory(
  ctx: Context, histories: WorkspaceHistories, spec: TurnSpec, workspace: Workspace, source: Id,
  signal: AbortSignal, legacy?: Id,
): Promise<void> {
  const label = visibleWorkspaceTitle(spec)
  if (!label) {
    return
  }
  const title = normalizeSessionTitle(label, 256)
  if (!title) {
    throw new Error('棱镜工作区历史标题无效')
  }
  const persistence = ctx.sessionPersistence
  await using input = await persistence.open(source, 'read', { signal })
  if (input.header.origin !== 'subagent' || input.header.cwd !== workspace.path) {
    return
  }
  const { events } = await input.read(0, undefined, { signal })
  const end = events.findLastIndex(event => event.type === 'turn/end')
  if (end < 0) {
    return
  }
  const digest = createHash('sha256').update(JSON.stringify([spec.owner, spec.layer, spec.bindingId])).digest('hex')
  const id = legacy ?? SessionId(historyPrefix + digest)
  const prefix = events.slice(0, end + 1)
  const mirrored = legacy ? prefix.map(withoutInheritedMarker) : prefix.map(event => historyEvent(event, title))
  const existing = await persistence.stat(id, { signal })
  const header = existing?.header ?? ctx.sessions.prepare(id, {
    meta: { cwd: workspace.path, createdAt: input.header.createdAt },
  }).header
  if (header.cwd !== workspace.path) {
    throw new Error('棱镜工作区历史目录已变更')
  }
  const output = await histories.open(id, signal, existing ? undefined : header)
  if (await appendHistory(output, mirrored, signal, legacy ? events : mirrored)) {
    // 旧版公开记录保留已有的继承边界，缓存应当使用实际持久化的事件。
    const snapshot = legacy ? (await output.read(0, undefined, { signal })).events : mirrored
    ctx.get('sessionProjectionCache')?.coldSnapshot(header, output.inheritedEventCount, snapshot)
  }
  await workspace.attachSession(id)
}
