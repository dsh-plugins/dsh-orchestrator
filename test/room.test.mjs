import test from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Orchestrator} from '../dist/core.js'

test('Room receipts admit only live addressed L2 members and deduplicate replay across nodes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-room-'))
  const projects = {
    a: {id: 'project', nodeId: 'a', description: '资料', stack: [], permissions: ['read']},
    b: {id: 'project', nodeId: 'b', description: '资料', stack: [], permissions: ['read']},
  }
  const models = {L1: [{id: 'top', description: 'L1'}], L2: [{id: 'plan', description: 'L2'}], L3: [{id: 'exec', description: 'L3'}]}
  const ready = Promise.withResolvers()
  const sent = Promise.withResolvers()
  const failures = []
  const messages = []
  let replay
  let core
  function signature(node, message) {
    return createHmac('sha256', 'test-' + node).update(message).digest('base64url')
  }
  function mesh(nodeId) {
    return {nodeId, nodeIds: ['a', 'b', 'hub'].filter(node => node !== nodeId),
      async queryProjects(node) { return projects[node] ? [projects[node]] : [] },
      sign: value => signature(nodeId, value),
      verify: (node, value, proof) => signature(node, value) === proof,
      async peerSend(target, content) {
        return workers.get(target.nodeId).receivePeerMessage(nodeId, {...content, targetAgentId: target.agentId})
      },
      async submitPeerInbox(_, message) {
        replay = message
        await assert.rejects(core.acceptPeerInbox('hub', message))
        await assert.rejects(core.acceptPeerInbox(nodeId, {...message, text: 'tampered'}))
        await core.acceptPeerInbox(nodeId, message)
        await core.acceptPeerInbox(nodeId, message)
      },
    }
  }
  const workers = new Map()
  for (const nodeId of ['a', 'b']) {
    workers.set(nodeId, new Orchestrator({models}, {}, {}, join(dir, nodeId),
      undefined, undefined, {workspace: {nodeId, projectId: 'prism-conversation', cwd: dir}, mesh: mesh(nodeId)}))
  }
  core = new Orchestrator({models, maxDepth: 1}, {query: () => []}, {
    async run(spec, raw, tools) {
      const event = JSON.parse(raw)
      const {invoke} = tools
      try {
        if (spec.layer === 'L1' && event.kind === 'user') {
          const visible = await invoke('query_projects', {})
          assert.equal(visible.length, 2)
          assert.ok(visible.every(project => !Object.hasOwn(project, 'workspace')))
          await invoke('agent_spawn', {room: true, agents: visible.map(project => ({
            nodeId: project.nodeId, projectId: project.id, modelId: 'plan', title: '检查', instruction: '调查',
          }))})
        } else if (spec.layer === 'L2' && event.kind === 'assignment') {
          assert.equal(spec.workspace.cwd, '')
          assert.equal(spec.maxDepth, 1)
          assert.ok(!tools.definitions.some(tool => tool.name === 'dispatch_executor' || tool.name === 'ask_user_question'))
          assert.equal(event.room.members.length, 2)
          assert.equal(Object.hasOwn(event.room, 'grant'), false)
          if (spec.workspace.nodeId === 'b') { ready.resolve(); await sent.promise; return }
          await ready.promise
          const receiver = event.room.members.find(member => member.nodeId === 'b').agentId
          const worker = workers.get('a')
          await assert.rejects(worker.invokePeerTool(spec, {target_node: 'hub', target_agent_id: receiver, text: 'forbidden'}))
          await worker.invokePeerTool(spec, {target_node: 'b', target_agent_id: receiver, text: '交叉证据'})
          sent.resolve()
          await invoke('send_parent', {text: 'a done', final: true})
        } else if (spec.layer === 'L2' && event.kind === 'peer_message') {
          messages.push(event.text)
          await invoke('send_parent', {text: 'b done', final: true})
        } else if (spec.layer === 'L1' && event.kind === 'task_settled') {
          await invoke('send_user', {text: event.result, final: true})
        }
      } catch (error) {
        failures.push(error)
        ready.resolve()
        sent.resolve()
        throw error
      }
    },
  }, join(dir, 'hub'), undefined, undefined, {workspace: {nodeId: 'hub', projectId: 'prism-conversation', cwd: dir}, mesh: mesh('hub')})
  try {
    await core.message('web:owner', '联合调查', 'message')
    await core.whenIdle()
    if (failures.length) { throw failures[0] }
    assert.deepEqual(messages, ['交叉证据'])
    assert.deepEqual((await core.view('web:owner')).tasks.map(task => task.status), ['completed', 'completed'])
    const late = {...replay, messageId: 'late'}
    const payload = JSON.stringify(['dsh-prism-peer/1', late.messageId, late.room.id, late.senderAgentId,
      late.targetAgentId, late.targetNodeId, late.text])
    await assert.rejects(core.acceptPeerInbox('b', {...late, proof: signature('a', payload)}), /授权已撤销/)
  } finally {
    await Promise.all([core.close(), ...[...workers.values()].map(worker => worker.close())])
    await rm(dir, {recursive: true, force: true})
  }
})
