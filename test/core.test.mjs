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
          const progress = await call('get_progress', {taskId:l2})
          assert.deepEqual(progress, JSON.parse(JSON.stringify(progress)))
          assert.equal(Object.hasOwn(progress, 'result'), false)
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
          if (event.kind === 'task_settled') {
            assert.equal(event.taskId, l3)
            assert.equal(event.result, '内部结果')
            assert.equal((await call('get_progress', {taskId: l3})).result, event.result)
          }
        }
        if (spec.layer === 'L3') {
          assert.equal(spec.workspace.cwd,'/private/invoice')
          assert.deepEqual(spec.allowedTools,['read'])
          await assert.rejects(call('dispatch_executor',{}))
          await call('send_parent',{text:'读取中'})
          await call('send_parent',{text:'内部结果', final:true})
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
    const notifications = turns.filter(turn => turn.spec.layer === 'L2' && turn.event.taskId === l3).map(turn => turn.event)
    assert.deepEqual(notifications.map(event => event.kind), ['child_message', 'task_settled'])
    assert.deepEqual(notifications.map(event => event.text ?? event.result), ['读取中', '内部结果'])
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
    // The production plugin retains its scheduler as a Cordis service. Expose
    // a live IPC reader so garbage collection cannot dispose this host's lease.
    process.on('message', async () => {
      const view = await core.view('alice')
      process.send(view.messages.map(message => message.delivery))
    })
    await new Promise(setImmediate)
    globalThis.gc()
    process.send('claimed')
  `
  const worker = spawn(process.execPath,['--expose-gc','--input-type=module','-e',script,dir], {stdio:['ignore','ignore','inherit','ipc']})
  t.after(()=>worker.kill('SIGKILL'))
  const closed = once(worker,'close')
  const ready = await Promise.race([once(worker,'message').then(([message])=>message),closed.then(()=>{throw new Error('scheduler exited before claim')})])
  assert.equal(ready,'claimed')
  const seen = []
  const core = new Orchestrator(config,registry,{async run(_spec,text){seen.push(JSON.parse(text).text)},async transcript(){return []}},dir)
  try {
    await core.start()
    await core.whenIdle()
    assert.deepEqual(seen,[])
    const liveSnapshot = once(worker, 'message')
    worker.send('snapshot')
    assert.deepEqual((await liveSnapshot)[0], ['pending','pending'])
    worker.kill('SIGKILL')
    await closed
    await core.start()
    await core.whenIdle()
    assert.deepEqual(seen,['second'])
    assert.deepEqual((await core.view('alice')).messages.map(m=>m.delivery),['failed','processed'])
  } finally { await core.close() }
})

test('host defaults follow the native model picker and the initial project stays authorized', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-host-default-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  let available = []
  const liveRegistry = {
    query: () => available,
    resolve(_owner, id) {
      const project = available.find(p => p.id === id)
      if (!project) throw new Error('Project access revoked')
      return project
    },
  }
  let route = {id: 'initial', provider: 'first', description: 'First route'}
  const firstTurn = Promise.withResolvers()
  const continueFirstTurn = Promise.withResolvers()
  const seen = []
  const runner = {
    async run(spec, raw, tools) {
      const event = JSON.parse(raw)
      seen.push([spec.workspace.projectId, spec.model.provider, spec.model.id])
      if (event.text === 'first') {
        firstTurn.resolve()
        await continueFirstTurn.promise
      }
      if (event.text === 'revoke-active') {
        available = []
        await assert.rejects(tools.invoke('query_projects', {}), /revoked/)
      }
    },
    async transcript() { return [] },
  }
  const open = () => new Orchestrator({useHostModel:true}, liveRegistry, runner, dir, () => ({...route}))
  const core = open()
  try {
    await core.start()
    await assert.rejects(core.view('alice'), /No authorized/)
    available = [projects.invoice, projects.lobby]
    assert.equal((await core.view('alice')).modelId, 'initial')
    await core.message('alice', 'first')
    await firstTurn.promise
    route = {id:'flash', provider:'custom', description:'Custom route'}
    await core.message('alice', 'second')
    route = {...route, provider:'another-route'}
    assert.deepEqual((await core.view('alice')).models, [{id:'flash', description:'Custom route'}])
    continueFirstTurn.resolve()
    await core.whenIdle()
    assert.deepEqual(seen, [['invoice','first','initial'],['invoice','custom','flash']])
  } finally { continueFirstTurn.resolve(); await core.close() }

  const resumed = open()
  try {
    available = [projects.lobby, projects.invoice]
    await resumed.start()
    await resumed.message('alice', 'revoke-active')
    await resumed.whenIdle()
    assert.deepEqual(seen.at(-1), ['invoice','another-route','flash'])
    await assert.rejects(resumed.message('alice', 'after-revoke', 'retry-after-grant'))
    assert.equal((await resumed.view('alice')).messages.length, 3)
    assert.equal(seen.length, 3)
    available = [projects.lobby]
    await resumed.message('alice', 'after-revoke', 'retry-after-grant')
    await resumed.message('alice', 'after-revoke', 'retry-after-grant')
    await resumed.whenIdle()
    assert.deepEqual(seen.at(-1), ['lobby','another-route','flash'])
    assert.equal(seen.length, 4)
    const {messages} = await resumed.view('alice')
    assert.deepEqual(messages.map(m => m.text), ['first','second','revoke-active','after-revoke'])
    assert.equal(messages.at(-1).delivery, 'processed')
  } finally { await resumed.close() }
})

test('moving a project creates a new root without redirecting queued work or losing conversation history', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-root-move-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  let project = projects.lobby
  const liveRegistry = {
    query: () => [project],
    resolve(_owner, id) {
      if (id !== project.id) throw new Error('Project access revoked')
      return project
    },
  }
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const turns = []
  const runner = {
    async run(spec, raw, tools) {
      const {text} = JSON.parse(raw)
      turns.push({text, binding:spec.bindingId, cwd:spec.workspace.cwd, node:spec.workspace.nodeId})
      if (text === 'in flight') {
        entered.resolve()
        await release.promise
        await tools.invoke('send_user', {text:'Stale result from the former directory'})
      }
      if (text === 'earlier') await tools.invoke('send_user', {text:'Earlier reply'})
    },
    async transcript() { return [] },
  }
  const hostModel = () => ({id:'flash', provider:'responses', description:'Responses'})
  const core = new Orchestrator({useHostModel:true}, liveRegistry, runner, dir, hostModel)
  try {
    await core.start()
    await core.message('alice', 'earlier', 'first')
    await core.whenIdle()
    await core.message('alice', 'in flight', 'active')
    await entered.promise
    await core.message('alice', 'queued in the former directory', 'queued')

    project = {...project, workspace:'/moved/lobby', nodeId:'other-node'}
    await core.message('alice', 'work in the new directory', 'recovery')
    await core.message('alice', 'work in the new directory', 'recovery')
    release.resolve()
    await core.whenIdle()

    assert.deepEqual(turns.map(turn => turn.text), ['earlier','in flight','work in the new directory'])
    assert.equal(turns[1].binding, turns[0].binding)
    assert.notEqual(turns[2].binding, turns[0].binding)
    assert.deepEqual([turns[0].cwd,turns[0].node], [projects.lobby.workspace,projects.lobby.nodeId])
    assert.deepEqual([turns[2].cwd,turns[2].node], [project.workspace,project.nodeId])
    const {messages} = await core.view('alice')
    assert.deepEqual(messages.map(m => m.text), [
      'earlier','Earlier reply','in flight','queued in the former directory','work in the new directory',
    ])
    assert.equal(messages[2].delivery, 'failed')
    assert.equal(messages[3].delivery, 'failed')
    assert.equal(messages[4].delivery, 'processed')
  } finally { release.resolve(); await core.close() }
})

test('delegated requests finish independently and a silent root gets one delivery-only turn', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-finalize-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const slowPlannerStarted = Promise.withResolvers()
  const releaseSlowPlanner = Promise.withResolvers()
  const otherReplySent = Promise.withResolvers()
  const finalized = []
  const observedErrors = []
  const assignment = text => ({projectId:'lobby', modelId:'flash', title:text, instruction:text})
  const runner = {
    async run(spec, raw, tools) {
      const event = JSON.parse(raw)
      try {
        if (spec.layer === 'L1' && event.kind === 'user') {
          await tools.invoke('dispatch_planner', assignment(event.text))
        } else if (spec.layer === 'L2' && event.kind === 'assignment') {
          if (event.text === 'first request') {
            slowPlannerStarted.resolve()
            await releaseSlowPlanner.promise
          }
          await tools.invoke('send_parent', {text:event.text + ' result', final:true})
        } else if (event.kind === 'task_settled' && event.result === 'second request result') {
          await tools.invoke('send_user', {text:'Second answer'})
          otherReplySent.resolve()
        } else if (event.kind === 'finalize_response') {
          finalized.push(event)
          assert.equal(spec.layer, 'L1')
          assert.deepEqual(tools.definitions.map(tool => tool.name), ['send_user'])
          await assert.rejects(tools.invoke('dispatch_planner', assignment('extra task')))
          await tools.invoke('send_user', {text:'First answer'})
        }
      } catch (error) { observedErrors.push(error); throw error }
    },
    async transcript() { return [] },
  }
  const core = new Orchestrator({useHostModel:true}, registry, runner, dir, () => model('flash'))
  try {
    await core.start()
    await core.message('alice', 'first request', 'slow-id')
    await slowPlannerStarted.promise
    await core.message('alice', 'second request', 'fast-id')
    await otherReplySent.promise
    assert.equal(finalized.length, 0)
    await core.message('alice', 'first request', 'slow-id')
    releaseSlowPlanner.resolve()
    await core.whenIdle()
    await core.message('alice', 'first request', 'slow-id')
    await core.whenIdle()
    assert.deepEqual(observedErrors, [])
    assert.equal(finalized.length, 1)
    assert.equal(finalized[0].userRequest, 'first request')
    assert.deepEqual(finalized[0].tasks.map(task => task.result), ['first request result'])
    const view = await core.view('alice')
    assert.equal(view.tasks.length, 2)
    assert.ok(view.tasks.every(task => task.status === 'completed'))
    assert.deepEqual(view.messages.map(m => m.text), ['first request','second request','Second answer','First answer'])
    assert.deepEqual(view.messages.filter(m => m.role === 'user').map(m => m.delivery), ['processed','processed'])
  } finally { releaseSlowPlanner.resolve(); await core.close() }
})

test('an unanswered delivery-only turn fails the originating message once, including after replay or restart', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-finalize-failure-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const events = []
  const runner = {
    async run(_spec, raw, tools) {
      const event = JSON.parse(raw)
      events.push(event.kind)
      if (event.kind === 'user') {
        await tools.invoke('dispatch_planner', {projectId:'lobby', modelId:'flash', title:'check', instruction:'check'})
      }
      if (event.kind === 'assignment') await tools.invoke('send_parent', {text:'Internal evidence', final:true})
      // Stop a broken retry loop so the assertions can report the duplicate turn.
      if (event.kind === 'finalize_response' && events.filter(kind => kind === 'finalize_response').length > 1) {
        await tools.invoke('send_user', {text:'Unexpected duplicate delivery turn'})
      }
    },
    async transcript() { return [] },
  }
  const open = () => new Orchestrator({useHostModel:true}, registry, runner, dir, () => model('flash'))
  let core = open()
  try {
    await core.start()
    await core.message('alice', 'check', 'check-id')
    await core.whenIdle()
    assert.equal(events.filter(kind => kind === 'finalize_response').length, 1)
    const before = await core.view('alice')
    assert.deepEqual(before.messages.map(m => [m.role,m.text,m.delivery]), [['user','check','failed']])
    assert.equal(before.tasks[0].status, 'completed')
    const turnCount = events.length
    await core.close()
    core = open()
    await core.start()
    await core.message('alice', 'check', 'check-id')
    await core.whenIdle()
    assert.equal(events.length, turnCount)
    assert.deepEqual((await core.view('alice')).messages, before.messages)
  } finally { await core.close() }
})

test('progress messages before dispatch and between planner results do not satisfy final delivery', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-progress-delivery-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const releaseSecond = Promise.withResolvers()
  const deliveryTurns = []
  let partial
  const runner = {
    async run(_spec, raw, tools) {
      const event = JSON.parse(raw)
      if (event.kind === 'user') {
        await tools.invoke('send_user', {text:'Checking the projects.'})
        for (const projectId of ['lobby','invoice']) {
          await tools.invoke('dispatch_planner', {projectId, modelId:'flash', title:projectId, instruction:projectId})
        }
      } else if (event.kind === 'assignment') {
        if (event.projectId === 'invoice') await releaseSecond.promise
        await tools.invoke('send_parent', {text:event.projectId + ' evidence', final:true})
      } else if (event.kind === 'task_settled' && event.projectId === 'lobby') {
        await tools.invoke('send_user', {text:'One of the two projects has reported.', final:false})
        partial = await core.view('alice')
        releaseSecond.resolve()
      } else if (event.kind === 'finalize_response') {
        deliveryTurns.push(event)
        await tools.invoke('send_user', {text:'Both results are ready.'})
      }
    },
    async transcript() { return [] },
  }
  const core = new Orchestrator({useHostModel:true}, registry, runner, dir, () => model('flash'))
  try {
    await core.start()
    await core.message('alice', 'Check both projects', 'cross-project')
    await core.whenIdle()
    assert.equal(deliveryTurns.length, 1)
    assert.deepEqual(deliveryTurns[0].tasks.map(task => task.result).sort(), ['invoice evidence','lobby evidence'])
    assert.equal(partial.messages.at(-1).text, 'One of the two projects has reported.')
    assert.equal(partial.tasks.find(task => task.title === 'invoice').status, 'running')
    const view = await core.view('alice')
    assert.equal(view.messages[0].delivery, 'processed')
    assert.deepEqual(view.messages.map(m => m.text), [
      'Check both projects','Checking the projects.','One of the two projects has reported.','Both results are ready.',
    ])
  } finally { releaseSecond.resolve(); await core.close() }
})

test('a dispatch update published after a fast planner settles does not count as the final answer', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-dispatch-receipt-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const completed = Promise.withResolvers()
  const publications = []
  const runner = {
    async run(_spec, raw, tools) {
      const event = JSON.parse(raw)
      if (event.kind === 'user') {
        await tools.invoke('send_user', {text:'收到，我会核对项目。', final:false})
        await tools.invoke('dispatch_planner', {projectId:'lobby', modelId:'flash', title:'核对项目', instruction:'查明项目用途'})
        await completed.promise
        await tools.invoke('send_user', {text:'已安排核对。', final:false})
      } else if (event.kind === 'assignment') {
        await tools.invoke('send_parent', {text:'接待台用于访客登记。', final:true})
      } else if (event.kind === 'finalize_response') {
        await assert.rejects(tools.invoke('send_user', {text:'仍在核对。', final:false}), /最终答复/)
        await tools.invoke('send_user', {text:event.tasks[0].result, final:true})
      }
    },
    async transcript() { return [] },
  }
  const core = new Orchestrator({useHostModel:true}, registry, runner, dir, () => model('flash'))
  const unsubscribe = core.subscribe('alice', snapshot => {
    if (snapshot.tasks[0]?.status === 'completed') completed.resolve()
    publications.push({task: snapshot.tasks[0]?.status, replies: snapshot.messages.slice(1).map(message => message.text)})
  })
  try {
    await core.start()
    await core.message('alice', '项目是做什么的？', 'fast-planner')
    await core.whenIdle()
    const replies = ['收到，我会核对项目。', '已安排核对。', '接待台用于访客登记。']
    assert.ok(publications.some(item => !item.task && item.replies.length === 1 && item.replies[0] === replies[0]))
    assert.ok(publications.some(item => item.task === 'completed' && item.replies.length === 2 && item.replies[1] === replies[1]))
    const view = await core.view('alice')
    assert.equal(view.messages[0].delivery, 'processed')
    assert.deepEqual(view.messages.slice(1).map(message => message.text), replies)
  } finally { unsubscribe(); completed.resolve(); await core.close() }
})

test('layer model rules distinguish providers and preserve accepted model and prompt snapshots', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-layer-models-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const rule = (provider, model, prompt) => ({provider, model, enabled:true, description:provider, prompt})
  const conversational = {...rule('provider-a', 'chat', '默认交互提示'), description: ''}
  const selected = rule('provider-b', 'chat', '原始交互提示')
  const plan = rule('provider-a', 'planner', '规划提示')
  const otherPlan = rule('provider-b', 'planner', '备用规划提示')
  const execution = rule('provider-c', 'worker', '执行提示')
  let rules = {L1:[conversational, selected], L2:[plan, otherPlan], L3:[execution]}
  const started = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const turns = []
  const failures = []
  const runner = {
    async run(spec, input, tools) {
      const event = JSON.parse(input)
      turns.push({spec,event})
      try {
        if (event.kind === 'user' && event.text === 'wait') {
          started.resolve()
          await resume.promise
        } else if (event.kind === 'user') {
          const options = await tools.invoke('list_models', {})
          assert.deepEqual(options.map(option => option.label), ['provider-a/planner','provider-b/planner'])
          await tools.invoke('dispatch_planner', {
            projectId:'lobby', modelId:options[0].id, title:'plan', instruction:'inspect'
          })
        } else if (event.kind === 'assignment' && spec.layer === 'L2') {
          const options = await tools.invoke('list_models', {})
          assert.equal(options[0].label, 'provider-c/worker')
          await tools.invoke('dispatch_executor', {modelId:options[0].id, title:'work', instruction:'execute'})
        } else if (spec.layer === 'L3' || (event.kind === 'task_settled' && spec.layer === 'L2')) {
          await tools.invoke('send_parent', {text:'done', final:true})
        } else if (event.kind === 'task_settled' || event.kind === 'finalize_response') {
          await tools.invoke('send_user', {text:'complete'})
        }
      } catch (error) {
        failures.push(error)
        throw error
      }
    },
    async transcript() { return [] },
  }
  const open = () => new Orchestrator({useHostModel:true}, registry, runner, dir,
    () => ({id:'chat',provider:'provider-a',description:'DSH default'}), () => rules)
  let core = open()
  try {
    const first = await core.view('alice')
    assert.deepEqual(first.models.map(item => item.label), ['provider-a/chat','provider-b/chat'])
    assert.equal(first.models[0].description, 'provider-a/chat')
    assert.notEqual(first.models[0].id, first.models[1].id)
    assert.equal(first.modelId, first.models[0].id)
    await core.selectModel('alice', first.models[1].id)
    await core.close()
    core = open()
    await core.start()
    assert.equal((await core.view('alice')).modelId, first.models[1].id)

    await core.message('alice', 'wait')
    await started.promise
    await core.message('alice', 'delegate')
    rules = {...rules, L1:[conversational, {...selected, enabled:false, prompt:'更新后的提示'}]}
    assert.equal((await core.view('alice')).modelId, first.models[0].id)
    await assert.rejects(core.selectModel('alice', first.models[1].id), {code:'INVALID_INPUT'})
    resume.resolve()
    await core.whenIdle()
    if (failures.length) throw failures[0]

    const planner = turns.find(turn => turn.spec.layer === 'L2').spec
    const executor = turns.find(turn => turn.spec.layer === 'L3').spec
    assert.equal(planner.model.model,'planner')
    assert.equal(executor.model.model,'worker')
    assert.match(planner.systemPrompt,/规划提示/)
    assert.match(executor.systemPrompt,/执行提示/)
    assert.equal(core.authorizeRemote(planner).model.provider,'provider-a')
    assert.throws(() => core.authorizeRemote({...planner,model:{id:'planner'}}))
    for (const {spec} of turns.filter(turn => turn.spec.layer === 'L1')) {
      assert.equal(spec.model.provider,'provider-b')
      assert.match(spec.systemPrompt,/原始交互提示/)
      assert.doesNotMatch(spec.systemPrompt,/更新后的提示/)
    }

    rules = {L1:[], L2:[], L3:[]}
    assert.equal((await core.view('alice')).modelId, 'chat')
  } finally {
    resume.resolve()
    await core.close()
  }
})
