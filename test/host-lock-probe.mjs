import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildForkSeed, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { DshSessionRunner } from '../dist/host.js'
import { SessionBindings } from '../dist/host-bindings.js'
import { isWorkspaceHistory } from '../dist/workspace-history.js'

export const name = 'prism-lock-probe'
export const inject = ['agents', 'sessions', 'agentLoop', 'agentPresets', 'sessionPersistence',
  'sessionQuery', 'sessionTitle', 'systemPrompt', 'tools', 'llm', 'workspaceRegistry', 'webServer', 'sessionController']

export function apply(ctx, config) {
  // A preset declaration and service mount can finish in different Cordis fibers.
  void (async () => {
    const host = new DshSessionRunner(ctx, config.directory)
    const stopGuard = ctx.on('agent/created', ({agent}) => host.guardHistoryAgent(agent), { prepend: true })
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
      const visibleSpec = { ...oldSpec, workspaceTitle: '棱镜' }
      await host.restoreWorkspaceHistory(visibleSpec)
      const restored = workspace.getSessionHeaders().find(header => isWorkspaceHistory(header.id))
      assert.ok(restored)
      assert.notEqual(restored.id, oldId)
      assert.equal(restored.origin, undefined)
      assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(oldId))
      assert.equal((await ctx.sessionQuery.readTitle(restored.id)).title, '棱镜')
      assert.ok((await host.transcript(visibleSpec)).some(entry => entry.text.includes('原始会话内容')))
      await host.restoreWorkspaceHistory(visibleSpec)
      assert.equal(await run(visibleSpec, '继续原来的会话'), oldId)
      assert.equal(workspace.sessionIds.filter(isWorkspaceHistory).length, 1)
      assert.ok((await ctx.sessionQuery.readSession(restored.id)).events.some(
        event => event.type === 'user/message' && JSON.stringify(event.data).includes('继续原来的会话')))
      assert.equal((await ctx.sessionPersistence.stat(restored.id)).header.isSeeded, false)
      await assert.rejects(ctx.agents.resume({resumeSessionId: restored.id}), {name: 'SessionAlreadyOwnedError'})

      const freshSpec = session('new-owner')
      const freshId = await run(freshSpec, '首次交互')

      const planner = { ...session('planner'), layer: 'L2', parentBindingId: 'new-owner' }
      const plannerId = await run(planner, '已取得执行步骤的结果')
      const worker = { ...session('worker'), layer: 'L3', parentBindingId: 'planner' }
      const workerId = await run(worker, '已完成执行步骤')
      const lock = await ctx.sessionPersistence.open(freshId, 'write')
      let replacement
      try {
        replacement = await run(freshSpec, '继续与棱镜对话')
        assert.notEqual(replacement, freshId)
        assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(freshId))
      } finally {
        await lock.close()
      }
      using bindings = new DatabaseSync(join(config.directory, 'sessions.sqlite'))
      bindings.prepare('INSERT INTO pending_archive VALUES (?, ?)').run('new-owner', freshId)
      assert.equal(await run(freshSpec, '继续交互'), replacement)
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

      const ordinarySpec = { ...session('old-ordinary'), workspaceTitle: '棱镜' }
      const ordinaryId = SessionId('session-prism-ordinary-fixture')
      const {events: originalEvents} = await ctx.sessionQuery.readSession(oldId)
      const endSeq = SessionLogOffset(originalEvents.length)
      const ordinary = await ctx.agents.create({
        sessionId: ordinaryId,
        seed: buildForkSeed(originalEvents, originalEvents.at(-1).seq),
        inheritedEventCount: endSeq,
        parentSource: {sessionId: oldId, endSeq},
        meta: {cwd: config.directory, agentPreset: 'prism-l1', isSeeded: true},
      })
      const legacyBindings = new SessionBindings(config.directory)
      try {
        assert.ok(legacyBindings.publish(ordinarySpec, undefined, ordinaryId))
        await ctx.sessions.flush(ordinary.agent.session)
      } finally {
        legacyBindings.close()
        await ordinary.dispose()
      }
      await host.restoreWorkspaceHistory(ordinarySpec)
      await assert.rejects(ctx.agents.resume({resumeSessionId: ordinaryId}), {name: 'SessionAlreadyOwnedError'})
      const privateRoot = await run(ordinarySpec, '旧原生会话继续运行')
      assert.notEqual(privateRoot, ordinaryId)
      assert.equal((await ctx.sessionPersistence.stat(privateRoot)).header.origin, 'subagent')
      assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(ordinaryId))
      assert.ok(!(await ctx.sessionQuery.readSession(privateRoot)).events.some(
        event => event.type === 'session/end-seed' && event.data.inherited === true))
      assert.ok((await ctx.sessionQuery.readSession(ordinaryId)).events.some(
        event => event.type === 'user/message' && JSON.stringify(event.data).includes('旧原生会话继续运行')))
      assert.equal(await run(ordinarySpec, '旧原生会话再次继续'), privateRoot)

      const childDirectory = join(config.directory, 'child')
      await mkdir(childDirectory)
      const cwd = await realpath(childDirectory)
      const childSpec = (layer, parentBindingId) => ({
        ...session('child-' + layer), layer, parentBindingId,
        workspace: { projectId: 'child', nodeId: 'local', cwd },
        workspaceTitle: '棱镜 ' + layer,
      })
      const l2 = childSpec('L2', oldSpec.bindingId)
      const l3 = childSpec('L3', l2.bindingId)
      const l2Id = await run(l2, '规划记录')
      const l3Id = await run(l3, '执行记录')
      assert.equal((await ctx.sessionPersistence.stat(l2Id)).header.origin, 'subagent')
      assert.equal((await ctx.sessionPersistence.stat(l3Id)).header.parentSession, l2Id)
      const childWorkspace = ctx.workspaceRegistry.list().find(workspace => workspace.path === cwd)
      assert.ok(childWorkspace)
      const mirrors = childWorkspace.sessionIds.filter(isWorkspaceHistory)
      assert.equal(mirrors.length, 2)
      const titles = await Promise.all(mirrors.map(async id => (await ctx.sessionQuery.readTitle(id)).title))
      assert.deepEqual(titles.sort(), ['棱镜 L2', '棱镜 L3'])
      const signal = new AbortController().signal
      const listing = await ctx.sessionController.list({}, signal)
      for (const id of mirrors) {
        const summary = listing.items.find(item => item.sessionId === id)
        assert.ok(summary && summary.origin === undefined && !summary.blank)
        const stream = ctx.sessionController.follow({address: {kind: 'session', sessionId: id}, activate: true}, signal)[Symbol.asyncIterator]()
        try {
          const opening = await stream.next()
          assert.equal(opening.value.type, 'snapshot')
          assert.equal(opening.value.header.id, id)
        } finally {
          await stream.return()
        }
        assert.equal(ctx.agents.get(id), undefined)
      }
      const imId = await run({ ...session('private-im'), owner: 'im:fixture', workspaceTitle: '棱镜' }, '私聊内容')
      assert.equal((await ctx.sessionPersistence.stat(imId)).header.origin, 'subagent')
      assert.equal(workspace.sessionIds.filter(isWorkspaceHistory).length, 1)
      const sharedIm = await run({...session('shared-im'), owner: 'im:fixture', workspaceTitle: '共享会话',
        showWorkspaceHistory: true}, '共享入口内容')
      assert.equal((await ctx.sessionPersistence.stat(sharedIm)).header.origin, 'subagent')
      assert.equal(workspace.sessionIds.filter(isWorkspaceHistory).length, 2)
      await host.close()
      const released = await ctx.sessionPersistence.open(restored.id, 'write')
      await released.close()
      process.stdout.write('PRISM_LOCK_OK\n')
    } catch (error) {
      process.stdout.write('PRISM_LOCK_ERROR ' + (error instanceof Error ? error.stack : String(error)) + '\n')
    } finally {
      stopGuard()
      await host.close()
    }
  })()
}
