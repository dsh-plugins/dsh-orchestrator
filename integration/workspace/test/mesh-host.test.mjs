import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { completeText, explicitText, privateText } from './fixture-model.mjs'
import { model, startHost, waitFor } from './host-helpers.mjs'

function project(id, nodeId, workspace, principals) {
  return { id, nodeId, workspace, principals, permissions: ['read'], stack: ['TypeScript'], description: '索引 ' + id }
}

function config(base, projects, node, defaultProjectId) {
  const role = id => ({ ...model(id, 'replace'), prompt: node.nodeId + '-PROMPT-' + id })
  return {
    registry: { projects },
    mesh: { ...node, stateDirectory: join(base, 'mesh') },
    orchestrator: {
      stateDirectory: join(base, 'prism'), defaultProjectId,
      models: { L1: [model('flash')], L2: [role('plan')], L3: [role('exec')] },
    },
  }
}

async function requests(host) {
  return (await readFile(host.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

test('two DSH hosts dispatch to peer-owned sessions, route active messages and read transcripts on demand', { timeout: 200_000 }, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'prism-mesh-integration-')))
  const coordinatorDir = join(base, 'coordinator')
  const workerDir = join(base, 'worker')
  const desk = join(coordinatorDir, 'desk')
  const shadow = join(coordinatorDir, 'code')
  const code = join(workerDir, 'code')
  const tokenEnv = 'PRISM_MESH_TEST_TOKEN'
  const env = { [tokenEnv]: randomUUID() }
  try {
    await Promise.all([desk, shadow, code].map(dir => mkdir(dir, { recursive: true })))
    await writeFile(join(code, 'probe.txt'), 'MESH-WORKER-FILE')
    await writeFile(join(shadow, 'probe.txt'), 'COORDINATOR-SHADOW-FILE')
    const worker = await startHost(t, workerDir, config(workerDir, [
      project('code', 'worker', code, ['web:owner']),
    ], { nodeId: 'worker', incoming: [{ id: 'desk-node', projects: ['code'], tokenEnv }] }, 'code'), env, { parallelBranches: true })
    const coordinator = await startHost(t, coordinatorDir, config(coordinatorDir, [
      project('desk', 'desk-node', desk, '*'), project('code', 'worker', shadow, '*'),
    ], { nodeId: 'desk-node', peers: [{ id: 'worker', url: worker.origin, tokenEnv }] }, 'desk'), env)
    const mesh = body => fetch(worker.origin + '/prism/mesh/v1', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-prism-node': 'desk-node', authorization: 'Bearer ' + env[tokenEnv] },
      body: JSON.stringify(body),
    })
    const target = { nodeId: 'worker', owner: 'web:owner', layer: 'L2', allowedTools: [], delegationCeiling: ['read'],
      projectId: 'code', modelId: 'plan', parentBindingId: 'local-parent', bindingId: 'probe' }
    assert.equal((await fetch(worker.origin + '/prism/mesh/v1', { method: 'POST' })).status, 401)
    for (const change of [{ owner: 'other' }, { projectId: 'unlisted' }, { delegationCeiling: ['write'] }]) {
      assert.equal((await mesh({ op: 'transcript', target: { ...target, ...change } })).status, 403)
    }
    const api = '/prism/api'
    const response = await coordinator.client(api + '/message', { text: '请读取远端项目资料', requestId: 'via-mesh' })
    assert.equal(response.status, 200, coordinator.diagnostic())
    let latest
    const diagnostics = () => [JSON.stringify(latest), coordinator.diagnostic(), worker.diagnostic()].join('\n')
    const view = await waitFor(async () => {
      latest = await (await coordinator.client(api + '/view')).json()
      if (latest.tasks?.some(task => task.status === 'failed') || latest.messages?.some(msg => msg.delivery === 'failed')) {
        throw new Error(diagnostics())
      }
      return latest.messages?.some(msg => msg.text === completeText) && latest
    }, diagnostics, 60000)
    assert.deepEqual(view.messages.map(msg => msg.text), ['请读取远端项目资料', explicitText, completeText])
    assert.equal(view.tasks.length, 3)
    assert(view.tasks.every(task => task.status === 'completed'))
    const planner = view.tasks.find(task => !task.parentId)
    assert.equal(view.tasks.filter(task => task.parentId === planner.id).length, 2)
    for (const task of view.tasks) {
      const result = await coordinator.client(api + '/trace?task=' + encodeURIComponent(task.id))
      assert.equal(result.status, 200, diagnostics())
      const trace = await result.json()
      assert(trace.some(entry => entry.text === privateText))
    }
    const [coordinatorRequests, workerRequests] = await Promise.all([requests(coordinator), requests(worker)])
    assert.deepEqual([...new Set(coordinatorRequests.map(r => r.model))], ['flash'])
    assert.deepEqual([...new Set(workerRequests.map(r => r.model))].sort(), ['exec', 'plan'])
    assert.equal(new Set(coordinatorRequests.map(r => r.session)).size, 1)
    assert.equal(new Set(workerRequests.map(r => r.session)).size, 3)
    for (const [records, directory] of [[coordinatorRequests, coordinatorDir], [workerRequests, workerDir]]) {
      const files = await readdir(join(directory, 'dsh', 'sessions'), { recursive: true })
      for (const session of new Set(records.map(record => record.session))) {
        assert(files.some(file => file.includes(session) && file.endsWith('session.v4.jsonl.zstd')), 'expected formal persisted DSH session')
      }
      for (const record of records.filter(record => record.model !== 'exec')) {
        assert(!JSON.stringify(record.runtimeContext).includes(base), 'planning/interaction runtime context exposed a path')
      }
    }
    assert(workerRequests.every(r => r.system.includes('worker-PROMPT-' + r.model)))
    assert(workerRequests.some(r => r.exchange?.name === 'read' && r.exchange.result.includes('MESH-WORKER-FILE')))
    assert(!JSON.stringify(workerRequests).includes('COORDINATOR-SHADOW-FILE'))
    assert(coordinatorRequests.some(r => r.input === 'child_message'))
    assert(workerRequests.some(r => r.model === 'plan' && r.input === 'parent_message'))
    assert(!JSON.stringify(view).includes(base))
  } finally {
    t.after(() => rm(base, { recursive: true, force: true }))
  }
})
