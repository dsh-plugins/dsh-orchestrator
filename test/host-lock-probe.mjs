import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DshSessionRunner } from '../dist/host.js'

export const name = 'prism-lock-probe'
export const inject = ['agents', 'sessions', 'agentLoop', 'agentPresets', 'sessionPersistence',
  'sessionQuery', 'systemPrompt', 'tools', 'workspaceRegistry', 'webServer']

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
              assert.equal(agent.session.header.parentSession, previous)
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
          assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(original)))
          assert.equal(await activate(), forked)
          ids.push(forked)
        } finally {
          await lock.close()
        }
      }
      assert.equal(new Set(ids).size, layers.length)
      process.stdout.write('PRISM_LOCK_OK\n')
    } catch (error) {
      process.stdout.write('PRISM_LOCK_ERROR ' + (error instanceof Error ? error.stack : String(error)) + '\n')
    } finally {
      await host.close()
    }
  })()
}
