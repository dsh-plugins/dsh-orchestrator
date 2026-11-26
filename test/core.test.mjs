import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Orchestrator} from '../dist/core.js'

const model = id => ({id, description: id + ' 的能力', prompt: id + ' 的提示词', promptMode: 'append'})
const config = {
  defaultProjectId: 'lobby', models: {L1: [model('chat-a'), model('chat-b')], L2: [model('planner')], L3: [model('worker')]},
}
const projects = {
  lobby: {id: 'lobby', description: '默认项目', nodeId: 'local', workspace: '/private/lobby', stack: [], permissions: []},
  invoice: {id: 'invoice', description: '账单项目', nodeId: 'remote', workspace: '/private/invoice', stack: ['ts'], permissions: ['read', 'write']},
}
const registry = {
  query(owner) { return Object.values(projects).filter(project => project.id === 'lobby' || owner === 'alice') },
  resolve(owner, id) {
    const project = this.query(owner).find(project => project.id === id)
    if (!project) throw new Error('unknown project')
    return project
  },
}

test('three persistent actors enforce grant ceilings, exchange addressed messages and publish only explicit sends', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-core-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const turns = []
  const failures = []
  let l2, l3, expired
  const runner = {
    async run(spec, raw, tools) {
      const event = JSON.parse(raw)
      turns.push({spec,event})
      try {
        const call = tools.invoke
        if (spec.layer === 'L1' && event.kind === 'user') {
          assert.deepEqual(spec.allowedTools, [])
          assert.equal(spec.workspace.cwd, '/private/lobby')
          assert.equal(spec.model.id, 'chat-b')
          await assert.rejects(call('bash', {command:'pwd'}))
          const projects = await call('query_projects', {})
          assert.ok(!JSON.stringify(projects).includes('/private'))
          assert.deepEqual(await call('list_models', {}), [{id:'planner',description:'planner 的能力'}])
          const task = {projectId:'invoice',modelId:'planner',title:'核对账单',instruction:'核对账单记录',permissions:['read']}
          await assert.rejects(call('dispatch_planner', {...task, modelId:'worker'}))
          await assert.rejects(call('dispatch_planner', {...task, permissions:['bash']}))
          l2 = (await call('dispatch_planner', task)).taskId
          await call('send_child', {taskId:l2, text:'使用只读检查'})
          await call('send_user', {text:'已安排核对。'})
          expired = tools
        }
        if (spec.layer === 'L2') {
          assert.deepEqual(spec.allowedTools, [])
          assert.deepEqual(spec.delegationCeiling, ['read'])
          assert.equal(spec.workspace.cwd,'/private/invoice')
          await assert.rejects(call('send_user',{text:'不应展示'}))
          if (event.kind === 'assignment') {
            assert.deepEqual(await call('list_models', {}), [{id:'worker',description:'worker 的能力'}])
            const task = {modelId:'worker',title:'private execution step',instruction:'读账单'}
            await assert.rejects(call('dispatch_executor',{...task,projectId:'lobby'}))
            await assert.rejects(call('dispatch_executor',{...task,permissions:['write']}))
            l3 = (await call('dispatch_executor',task)).taskId
            await call('report_progress',{text:'核对中'})
            await call('send_parent',{text:'正在核对'})
          }
          if (event.kind === 'task_settled') assert.equal(event.taskId,l3)
        }
        if (spec.layer === 'L3') {
          assert.equal(spec.workspace.cwd,'/private/invoice')
          assert.deepEqual(spec.allowedTools,['read'])
          await assert.rejects(call('dispatch_executor',{}))
          await call('send_parent',{text:'内部结果'})
        }
        if (spec.layer === 'L1' && event.kind === 'child_message') {
          assert.ok((await call('get_progress',{taskId:l2})).children.length >= 1)
          await assert.rejects(call('get_progress',{taskId:l3}))
        }
        if (spec.layer === 'L1' && event.kind === 'task_settled') {
          assert.equal(event.taskId,l2)
          await call('send_user',{text:'核对完成。'})
        }
      } catch (error) { failures.push(error); throw error }
      return 'private assistant text'
    },
    async transcript(spec) { return [{role:'assistant', text:'私有轨迹 '+spec.layer}] },
  }
  const core = new Orchestrator(config, registry, runner, dir)
  await core.start()
  try {
    await core.selectModel('alice','chat-b')
    const writes = await Promise.all([core.message('alice','核对账单','tg:1'),core.message('alice','核对账单','tg:1')])
    assert.equal(writes[0].messages.length,1)
    await core.whenIdle()
    if (failures.length) throw failures[0]
    const view = await core.view('alice')
    assert.deepEqual(view.messages.map(({text})=>text),['核对账单','已安排核对。','核对完成。'])
    assert.ok(view.tasks.length === 2 && view.tasks.every(task=>task.status==='completed'))
    assert.equal(view.messages[0].delivery,'processed')
    assert.deepEqual(view.tasks.map(({title})=>title),['核对账单','执行步骤'])
    assert.ok(!JSON.stringify(view).includes('/private'))
    assert.ok(!JSON.stringify(view).includes('内部结果'))
    assert.equal((await core.trace('alice',l2))[0].text,'私有轨迹 L2')
    await assert.rejects(core.trace('bob',l2), {code:'NOT_FOUND'})
    await assert.rejects(core.selectModel('alice','planner'),{code:'INVALID_INPUT'})
    await assert.rejects(expired.invoke('send_user',{text:'expired'}))
    const spec = turns.find(turn=>turn.spec.layer==='L3').spec
    assert.match(spec.systemPrompt,/worker 的提示词/)
    const canonical = core.authorizeRemote({...spec, systemPrompt:'fake', workspace:{...spec.workspace,cwd:'/elsewhere'}})
    assert.equal(canonical.workspace.cwd,'/private/invoice')
    assert.equal(canonical.systemPrompt,spec.systemPrompt)
    assert.throws(()=>core.authorizeRemote({...spec,owner:'bob'}))
    assert.throws(()=>core.authorizeRemote({...spec,allowedTools:['bash']}))
    assert.ok(turns.some(turn=>turn.spec.layer==='L2' && turn.event.kind==='parent_message'))
    assert.ok(turns.some(turn=>turn.spec.layer==='L2' && turn.event.kind==='child_message'))
    assert.equal(new Set(turns.filter(t=>t.spec.layer==='L1').map(t=>t.spec.bindingId)).size,1)
  } finally { await core.close() }

  const resumed = new Orchestrator(config, registry, runner, dir)
  try {
    await resumed.start()
    const view = await resumed.message('alice','核对账单','tg:1')
    assert.equal(view.messages.length,3)
    assert.equal(view.modelId,'chat-b')
    assert.equal(view.tasks[0].id,l2)
    await resumed.whenIdle()
  } finally { await resumed.close() }
})

test('switching L1 models preserves the bound session and the model chosen for each accepted turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-model-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  let release
  const hold = new Promise(resolve=>{release=resolve})
  const seen = []
  const runner = {
    async run(spec) { seen.push([spec.bindingId,spec.model.id]); await hold },
    async transcript() { return [] },
  }
  const core = new Orchestrator(config, registry, runner, dir)
  try {
    await core.start()
    await core.message('alice', 'one')
    await core.selectModel('alice','chat-b')
    await core.message('alice', 'two')
    release()
    await core.whenIdle()
    assert.deepEqual(seen.map(([,id])=>id), ['chat-a','chat-b'])
    assert.equal(seen[0][0],seen[1][0])
    assert.deepEqual((await core.view('alice')).messages.map(m=>m.role), ['user','user'])
  } finally { release(); await core.close() }
})

test('exact replacement and default append do not change the role capability ceiling', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-prompts-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const settings = structuredClone(config)
  settings.models.L1[0].promptMode = 'replace'
  settings.models.L1[0].prompt = '完整的 {{literal}} 提示词'
  delete settings.models.L1[1].promptMode
  const observed = []
  const core = new Orchestrator(settings, registry, {
    async run(spec, raw, tools) {
      observed.push({prompt:spec.systemPrompt, mode:spec.model.promptMode, tools:tools.definitions.map(d=>d.name), names:spec.allowedTools})
    }, async transcript() { return [] },
  }, dir)
  try {
    await core.start()
    await core.message('alice','first')
    await core.selectModel('alice','chat-b')
    await core.message('alice','second')
    await core.whenIdle()
    assert.equal(observed[0].prompt,settings.models.L1[0].prompt)
    assert.match(observed[1].prompt,/send_user/)
    assert.ok(observed[1].prompt.endsWith(settings.models.L1[1].prompt))
    assert.deepEqual(observed[0].tools,observed[1].tools)
    assert.deepEqual(observed.map(turn=>turn.names),[[],[]])
  } finally { await core.close() }
})

test('a killed scheduler releases ownership; the next host marks in-flight work failed and runs queued work once', async t => {
  const {spawn} = await import('node:child_process')
  const {once} = await import('node:events')
  const dir = await mkdtemp(join(tmpdir(), 'prism-recovery-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const script = `
    import {Orchestrator} from ${JSON.stringify(new URL('../dist/core.js', import.meta.url).href)}
    const project = ${JSON.stringify(projects.lobby)}
    const registry = {query:()=>[project], resolve:()=>project}
    let entered
    const ready = new Promise(r=>{entered=r})
    const core = new Orchestrator(${JSON.stringify(config)},registry,{
      async run(){entered(); await new Promise(()=>{})}, async transcript(){return []}
    }, process.argv[1])
    await core.start()
    await core.message('alice','first')
    await ready
    await core.message('alice','second')
    setInterval(()=>{},60000)
    process.stdout.write('claimed')
  `
  const worker = spawn(process.execPath,['--input-type=module','-e',script,dir], {stdio:['ignore','pipe','inherit']})
  t.after(()=>worker.kill('SIGKILL'))
  const closed = once(worker,'close')
  const ready = await Promise.race([once(worker.stdout,'data').then(([chunk])=>String(chunk)),closed.then(()=>{throw new Error('scheduler exited before claim')})])
  assert.equal(ready,'claimed')
  const seen = []
  const core = new Orchestrator(config,registry,{async run(_spec,text){seen.push(JSON.parse(text).text)},async transcript(){return []}},dir)
  try {
    await core.start()
    await core.whenIdle()
    assert.deepEqual(seen,[])
    worker.kill('SIGKILL')
    await closed
    await core.start()
    await core.whenIdle()
    assert.deepEqual(seen,['second'])
    assert.deepEqual((await core.view('alice')).messages.map(m=>m.delivery),['failed','processed'])
  } finally { await core.close() }
})
