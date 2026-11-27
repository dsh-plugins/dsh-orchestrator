import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DshSessionRunner } from '../dist/host.js'

export const name = 'prism-lock-probe'
export const inject = ['agents', 'sessions', 'agentLoop', 'agentPresets', 'sessionPersistence',
  'sessionQuery', 'sessionTitle', 'systemPrompt', 'tools', 'llm', 'workspaceRegistry', 'webServer']

export function apply(ctx, config) {
  // A preset declaration and service mount can finish in different Cordis fibers.
  void (async () => {
    const host = new DshSessionRunner(ctx, config.directory)
    try {
      while (!(await ctx.agentPresets.list()).some(preset => preset.id === 'prism-l3')) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const ids = []
      const layers = ['L1', 'L2', 'L3']
      for (const layer of layers) {
        const bindingId = 'binding-' + layer
        const spec = { bindingId, layer, owner: 'test', model: { id: 'offline-test', provider: 'probe', description: '' },
          workspace: { projectId: 'test', nodeId: 'local', cwd: config.directory },
          parentBindingId: layer === 'L1' ? undefined : 'binding-' + (layer === 'L2' ? 'L1' : 'L2'),
          systemPrompt: '测试提示词', allowedTools: layer === 'L3' ? ['read'] : [] }
        const tools = { definitions: [{ name: 'verify_probe', parameters: { type: 'object' }, description: 'probe' }],
          async invoke() { return null } }
        const observed = new Error('setup inspected')
        const activate = async previous => {
          let current = ''
          await assert.rejects(host.run(spec, 'ignored', tools, undefined, id => {
            current = id
            const agent = host.activeAgent(bindingId)
            const names = ctx.tools.schemas(agent).map(tool => tool.name).sort()
            assert.deepEqual(names, layer === 'L3' ? ['read', 'verify_probe'] : ['verify_probe'])
            assert.equal(agent.session.header.cwd, config.directory)
            assert.equal(agent.model.current()?.model, spec.model.id)
            if (previous) {
              assert.equal(agent.session.header.parentSession, ids.at(-1))
              assert.ok(agent.session.header.isSeeded)
              assert.ok(agent.session.snapshotEvents().some(e => e.type === 'session/end-seed'))
            }
            throw observed // stop before the LLM call; no inference credentials required.
          }), e => e === observed)
          return current
        }
        const original = await activate()
        const lock = await ctx.sessionPersistence.open(SessionId(original), 'write')
        try {
          // A separate runner opens the same index. Viewing a locked session never takes its lease.
          const reader = new DshSessionRunner(ctx, config.directory)
          try {
            assert.deepEqual(await reader.transcript(spec), [])
            assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(original)))
            await assert.rejects(reader.transcript({ ...spec, owner: 'someone-else' }), /different scope/)
          } finally {
            await reader.close()
          }
          const forked = await activate(original)
          assert.notEqual(original, forked)
          assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(original)), layer === 'L3')
          assert.equal(await activate(), forked)
          ids.push(forked)
        } finally {
          await lock.close()
        }
      }
      assert.equal(new Set(ids).size, layers.length)
      while (!ctx.llm.listProviders().some(provider => provider.id === 'prism-probe')) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const session = bindingId => ({
        bindingId, owner: 'web:owner', layer: 'L1',
        workspace: { projectId: 'test', nodeId: 'local', cwd: config.directory },
        model: { id: 'alternative', provider: 'prism-probe', description: '' },
        systemPrompt: '测试棱镜交互会话', allowedTools: [],
      })
      const workspace = ctx.workspaceRegistry.list().find(workspace => workspace.path === config.directory)
      assert.ok(workspace)
      const run = async (spec, text) => {
        let id
        await host.run(spec, JSON.stringify({ kind: 'user', text }), {
          definitions: [],
          async invoke() { throw new Error('未预期的工具调用') },
        }, undefined, value => { id = value })
        assert.ok(id)
        return id
      }
      const oldSpec = session('old-owner')
      const oldId = await run(oldSpec, '原始会话内容')
      assert.equal((await ctx.sessionPersistence.stat(oldId)).header.origin, 'subagent')
      const visibleSpec = { ...oldSpec, workspaceVisible: true }
      await host.restoreOwnerSession(visibleSpec)
      const restored = workspace.getSessionHeaders().find(header => header.origin === undefined)
      assert.ok(restored)
      assert.notEqual(restored.id, oldId)
      assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(oldId))
      assert.equal((await ctx.sessionQuery.readTitle(restored.id)).title, '棱镜')
      assert.ok((await host.transcript(visibleSpec)).some(entry => entry.text.includes('原始会话内容')))
      await host.restoreOwnerSession(visibleSpec)
      assert.equal(await run(visibleSpec, '继续原来的会话'), restored.id)

      const freshId = await run({ ...session('new-owner'), workspaceVisible: true }, '首次交互')
      assert.ok(workspace.sessionIds.includes(freshId))
      assert.equal((await ctx.sessionPersistence.stat(freshId)).header.origin, undefined)
      assert.equal((await ctx.sessionQuery.readTitle(freshId)).title, '棱镜')

      const planner = { ...session('planner'), layer: 'L2', parentBindingId: 'new-owner' }
      const plannerId = await run(planner, '已取得执行步骤的结果')
      const worker = { ...session('worker'), layer: 'L3', parentBindingId: 'planner' }
      const workerId = await run(worker, '已完成执行步骤')
      const lock = await ctx.sessionPersistence.open(freshId, 'write')
      let replacement
      try {
        replacement = await run({ ...session('new-owner'), workspaceVisible: true }, '继续与棱镜对话')
        assert.notEqual(replacement, freshId)
        assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(freshId))
      } finally {
        await lock.close()
      }
      using bindings = new DatabaseSync(join(config.directory, 'sessions.sqlite'))
      bindings.prepare('INSERT INTO pending_archive VALUES (?, ?)').run('new-owner', freshId)
      assert.equal(await run({ ...session('new-owner'), workspaceVisible: true }, '继续交互'), replacement)
      assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(freshId))
      assert.equal(await run(planner, '旧父会话仍存在，继续整理结果'), plannerId)
      await ctx.workspaceRegistry.archiveSession(freshId, { stopActivity: true })
      const repaired = await run(planner, '从旧版已归档的父会话恢复汇总')
      assert.notEqual(repaired, plannerId)
      assert.equal((await ctx.sessionPersistence.stat(repaired)).header.parentSession, replacement)
      assert.ok((await host.transcript(planner)).some(entry => entry.text.includes('已取得执行步骤的结果')))
      assert.equal(await run(planner, '下一轮继续沿用会话'), repaired)
      const repairedWorker = await run(worker, '沿当前父链继续执行')
      assert.notEqual(repairedWorker, workerId)
      assert.equal((await ctx.sessionPersistence.stat(repairedWorker)).header.parentSession, repaired)
      assert.ok((await host.transcript(worker)).some(entry => entry.text.includes('已完成执行步骤')))
      const activeLease = await ctx.sessionPersistence.open(repaired, 'write')
      try {
        await ctx.workspaceRegistry.archiveSession(repaired, { stopActivity: true })
        await assert.rejects(run(planner, '手动归档后不能自动续跑'), /棱镜会话已归档/)
        await assert.rejects(run(worker, '本次工作所属的父会话已归档'), /棱镜父会话已归档/)
      } finally {
        await activeLease.close()
      }

      const imId = await run({ ...session('private-im'), owner: 'im:fixture', workspaceVisible: true }, '私聊内容')
      assert.equal((await ctx.sessionPersistence.stat(imId)).header.origin, 'subagent')
      process.stdout.write('PRISM_LOCK_OK\n')
    } catch (error) {
      process.stdout.write('PRISM_LOCK_ERROR ' + (error instanceof Error ? error.stack : String(error)) + '\n')
    } finally {
      await host.close()
    }
  })()
}
