import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Orchestrator} from '../dist/core.js'

test('specialist grants and staged assets remain bound to the originating request', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'prism-extensions-')))
  const workspaces = Object.fromEntries(['conversation', 'memories', 'events'].map(name => [name, join(dir, name)]))
  await Promise.all(Object.values(workspaces).map(path => mkdir(path)))
  const models = {L1: [{id: 'lobby', description: 'L1'}], L2: [{id: 'worker', description: 'L2'}], L3: [{id: 'executor', description: 'L3'}]}
  const failures = []
  const documents = []
  const seen = []
  let route
  const testAsset = {assetId: 'asset-a', mimeType: 'image/png'}
  const memory = {
    workspace: workspaces.memories,
    async write(input) {
      documents.push(input)
      return {documentId: 'doc-a'}
    },
    async stageMedia() { return testAsset },
    async readMedia() { return {...testAsset, bytes: Uint8Array.of(1)} },
    async search(input) { return [{documentId: 'doc-a', fragment: input.assetId ?? input.query}] },
  }
  const triggers = {
    workspace: workspaces.events,
    async add(_options, addressed) {
      route = addressed
      return {id: 'subscription'}
    },
  }
  const core = new Orchestrator({models}, {query: () => []}, {
    async run(spec, raw, tools) {
      const event = JSON.parse(raw)
      const {invoke} = tools
      const names = tools.definitions.map(tool => tool.name)
      seen.push(event.kind)
      try {
        if (event.kind === 'trigger_event') {
          assert.ok(!names.includes('event_add'))
          assert.equal(event.source.sender, 'cron')
          await invoke('send_user', {text: '定时通知', final: true, replyTo: event.replyTo})
        } else if (event.kind === 'user') {
          assert.deepEqual(event.attachments, [testAsset])
          await assert.rejects(invoke('memory_write', {title: 'x', body: 'y'}))
          await invoke('event_add', {providerId: 'cron', params: {expression: '* * * * *'}})
          await invoke('spawn_memory_agent', {title: '保存', modelId: 'worker', instruction: '保存附件'})
        } else if (event.kind === 'assignment') {
          assert.equal(spec.workspace.cwd, workspaces.memories)
          assert.ok(!names.includes('dispatch_executor'))
          assert.ok(!names.includes('ask_user_question'))
          assert.ok(!names.includes('event_provider_publish'))
          await assert.rejects(invoke('memory_write', {title: '图', body: '', attachments: [{assetId: 'other'}]}))
          assert.deepEqual(await invoke('memory_search', {assetId: 'asset-a'}), [{documentId: 'doc-a', fragment: 'asset-a'}])
          await invoke('memory_write', {title: '图', body: '', attachments: [{assetId: 'asset-a'}]})
          await invoke('send_parent', {text: 'doc-a', final: true})
        } else {
          await invoke('send_user', {text: event.result, final: true})
        }
      } catch (error) {
        failures.push(error)
        throw error
      }
    },
    async transcript() { return [] },
  }, dir, undefined, undefined, {workspace: {projectId: 'prism-conversation', nodeId: 'local', cwd: workspaces.conversation},
    extensions: {memory: () => memory, triggers: () => triggers}})
  try {
    await core.start()
    await assert.rejects(core.message('web:owner', '', 'not-staged', undefined, ['asset-a']))
    assert.deepEqual(await core.stageMedia('web:owner', {bytes: Uint8Array.of(1), mimeType: 'image/png'}), testAsset)
    assert.equal(await core.readMedia('web:owner', 'asset-a'), undefined)
    await core.message('web:owner', '', 'staged', undefined, ['asset-a'])
    await core.whenIdle()
    assert.deepEqual((await core.readMedia('web:owner', 'asset-a')).bytes, Uint8Array.of(1))
    assert.equal(documents.length, 1)
    const event = {eventId: 'stable', source: 'cron', payload: {hello: true}, occurredAt: new Date().toISOString(), route}
    await Promise.all([core.acceptTrigger(event), core.acceptTrigger(event)])
    await core.whenIdle()
    if (failures.length) { throw failures[0] }
    assert.equal(seen.filter(kind => kind === 'trigger_event').length, 1)
    assert.equal((await core.view('web:owner')).messages.at(-1).text, '定时通知')
  } finally {
    await core.close()
    await rm(dir, {recursive: true, force: true})
  }
})
