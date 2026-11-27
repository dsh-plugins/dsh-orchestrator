import {randomUUID} from 'node:crypto'
import {chmodSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {Layer, ModelConfig, PublicMessage, TaskCard, WorkspaceTarget} from './contracts.js'

export interface Binding {
  id: string
  layer: Layer
  modelId: string
  hostModel?: ModelConfig
  target: WorkspaceTarget
  ceiling: string[]
}

export interface Task extends Binding {
  parent: string
  title: string
  status: TaskCard['status']
  at: string
  progress: string
  finalReport?: string
  turnFailed?: boolean
}

export interface Job {
  id: string
  bindingId: string
  modelId: string
  hostModel?: ModelConfig
  text: string
  worker?: string | number
  messageId?: string
  originId?: string
  deliveryOnly?: boolean
}

export interface Conversation {
  root: Binding
  previousRoots?: Binding[]
  awaitingReplies?: Record<string, {rootId: string; plannerIds: string[]; delivered?: boolean; hostModel?: ModelConfig}>
  tasks: Task[]
  messages: PublicMessage[]
  requests: string[]
  queue: Job[]
}

export function enqueue(state: Conversation, target: Binding, text: string, messageId?: string, originId?: string): Job {
  const requestModel = target.layer === 'L1' && originId ? state.awaitingReplies?.[originId]?.hostModel : undefined
  const job: Job = {
    id: randomUUID(), bindingId: target.id, modelId: requestModel?.id ?? target.modelId,
    hostModel: requestModel ?? target.hostModel, text, messageId, originId,
  }
  state.queue.push(job)
  return job
}

export class ConversationStore {
  private db: DatabaseSync
  readonly workerId = randomUUID()
  private readonly lease: DatabaseSync
  private readonly leaseDir: string

  constructor(dir: string) {
    mkdirSync(dir, {recursive: true, mode: 0o700})
    const path = join(dir, 'conversations.sqlite')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS conversations (owner TEXT PRIMARY KEY, content TEXT NOT NULL)')
    // An OS-released SQLite lock identifies this exact scheduler, including after PID reuse.
    this.leaseDir = join(dir, 'workers')
    mkdirSync(this.leaseDir, {recursive: true, mode: 0o700})
    this.lease = new DatabaseSync(join(this.leaseDir, this.workerId))
    this.lease.exec('BEGIN EXCLUSIVE')
  }

  workerAlive(worker: string | number): boolean {
    if (typeof worker === 'number') {
      try { process.kill(worker, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    }
    if (worker === this.workerId) return true
    if (!/^[0-9a-f-]{36}$/.test(worker)) throw new Error('无效的任务运行者标识')
    const path = join(this.leaseDir, worker)
    if (!existsSync(path)) return false
    const probe = new DatabaseSync(path)
    try {
      probe.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if ((error as {errcode?: number}).errcode === 5) return true // SQLITE_BUSY
      throw error
    } finally { probe.close() }
    rmSync(path, {force:true})
    return false
  }

  owners(): string[] {
    return this.db.prepare('SELECT owner FROM conversations').all().map(row => String(row.owner))
  }

  read(owner: string): Conversation | undefined {
    const row = this.db.prepare('SELECT content FROM conversations WHERE owner=?').get(owner)
    return row && JSON.parse(String(row.content)) as Conversation
  }

  /** Commit the message, task transition and any resulting parent event together. */
  change<T>(owner: string, make: () => Conversation, fn: (state: Conversation) => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.read(owner) ?? make()
      const result = fn(state)
      this.db.prepare('INSERT INTO conversations(owner,content) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET content=excluded.content')
        .run(owner, JSON.stringify(state))
      this.db.exec('COMMIT')
      return result
    } catch (cause) {
      this.db.exec('ROLLBACK')
      throw cause
    }
  }

  close(): void {
    this.lease.close()
    rmSync(join(this.leaseDir, this.workerId), {force:true})
    this.db.close()
  }
}
