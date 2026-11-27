import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TurnSpec } from './contracts.js'

/** Updating the binding and recording the archive obligation is one durable commit.
 * A failed archive can be retried even after the host restarts. */
export class SessionBindings {
  private readonly db: DatabaseSync

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'sessions.sqlite')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS bindings (
        binding TEXT PRIMARY KEY, scope TEXT NOT NULL, session TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS pending_archive (binding TEXT NOT NULL, session TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS legacy_histories (binding TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE);
    `)
  }

  private scope(spec: TurnSpec): string {
    return JSON.stringify([spec.owner, spec.layer, spec.workspace.nodeId, spec.workspace.projectId,
      spec.workspace.cwd, spec.parentBindingId ?? null])
  }

  current(spec: TurnSpec): SessionId | undefined {
    const row = this.db.prepare('SELECT scope, session FROM bindings WHERE binding = ?').get(spec.bindingId)
    if (!row) return undefined
    if (row.scope !== this.scope(spec)) throw new Error('Session binding belongs to a different scope')
    return SessionId(String(row.session))
  }

  isWebRoot(session: SessionId): boolean {
    const row = this.db.prepare('SELECT scope FROM bindings WHERE session = ?').get(session)
    if (!row) {
      return false
    }
    const [owner, layer] = JSON.parse(String(row.scope)) as string[]
    return owner === 'web:owner' && layer === 'L1'
  }

  legacyHistory(binding: string): SessionId | undefined {
    const row = this.db.prepare('SELECT session FROM legacy_histories WHERE binding = ?').get(binding)
    return row ? SessionId(String(row.session)) : undefined
  }

  isLegacyHistory(session: SessionId): boolean {
    return this.db.prepare('SELECT 1 FROM legacy_histories WHERE session = ?').get(session) !== undefined
  }

  convertVisibleRoot(spec: TurnSpec, original: SessionId, next: SessionId): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.current(spec) !== original) {
        throw new Error('原交互会话绑定已变更')
      }
      this.db.prepare('UPDATE bindings SET session = ? WHERE binding = ?').run(next, spec.bindingId)
      this.db.prepare('INSERT INTO legacy_histories VALUES (?, ?)').run(spec.bindingId, original)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  parent(spec: TurnSpec): SessionId | undefined {
    if (spec.layer === 'L1') {
      if (spec.parentBindingId !== undefined) throw new Error('L1 cannot have a parent binding')
      return undefined
    }
    if (spec.parentBindingId === undefined) throw new Error('Child session requires a parent binding')
    const row = this.db.prepare('SELECT scope, session FROM bindings WHERE binding = ?').get(spec.parentBindingId)
    if (!row) {
      // Only L2 can have its parent on a different Mesh node.
      if (spec.layer === 'L3') throw new Error('L3 requires its local L2 parent')
      return undefined
    }
    const [owner, layer, nodeId, projectId, cwd] = JSON.parse(String(row.scope)) as string[]
    if (owner !== spec.owner || (spec.layer === 'L2' ? layer !== 'L1' : spec.layer !== 'L3' || layer !== 'L2')
      || (spec.layer === 'L3' && (projectId !== spec.workspace.projectId || nodeId !== spec.workspace.nodeId || cwd !== spec.workspace.cwd))) {
      throw new Error('Invalid parent session scope')
    }
    return SessionId(String(row.session))
  }

  publish(spec: TurnSpec, expected: SessionId | undefined, next: SessionId, parent?: SessionId): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.current(spec)
      if (current !== expected || this.parent(spec) !== parent) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare(`INSERT INTO bindings VALUES (?, ?, ?)
        ON CONFLICT(binding) DO UPDATE SET session = excluded.session`).run(spec.bindingId, this.scope(spec), next)
      // L1 和 L2 的旧会话仍可能是其他任务的父会话，归档会阻止这些任务继续运行。
      if (expected !== undefined && spec.layer === 'L3') this.queueArchive(spec.bindingId, expected)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  queueArchive(binding: string, session: SessionId): void {
    this.db.prepare('INSERT OR IGNORE INTO pending_archive VALUES (?, ?)').run(binding, session)
  }

  pending(binding: string): SessionId[] {
    return this.db.prepare('SELECT session FROM pending_archive WHERE binding = ?').all(binding)
      .map(row => SessionId(String(row.session)))
  }

  childSessions(binding: string): SessionId[] {
    return this.db.prepare("SELECT session FROM bindings WHERE json_extract(scope, '$[5]') = ?").all(binding)
      .map(row => SessionId(String(row.session)))
  }

  archived(session: SessionId): void {
    this.db.prepare('DELETE FROM pending_archive WHERE session = ?').run(session)
  }

  close(): void { this.db.close() }
}
