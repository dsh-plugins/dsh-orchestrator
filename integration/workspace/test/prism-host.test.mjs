import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { model, startHost, waitFor } from './host-helpers.mjs'
import { privateText, explicitText, completeText } from './fixture-model.mjs'

test('real DSH Web sends a task through three scoped agents and only publishes explicit L1 replies', { timeout: 85000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'prism-integration-')))
  const desk = join(directory, 'desk')
  const code = join(directory, 'code')
  try {
    await Promise.all([mkdir(desk), mkdir(code)])
    await writeFile(join(code, 'probe.txt'), 'PROBE-EXECUTION-WORKSPACE')
    const projects = [ ['desk', desk], ['code', code] ].map(([id, workspace]) => ({
      id, workspace, description: '索引 ' + id, stack: ['TypeScript'], nodeId: 'local', principals: '*', permissions: ['read', 'write'],
    }))
    const host = await startHost(t, directory, {
      registry: { projects },
      orchestrator: { stateDirectory: join(directory, 'prism'), defaultProjectId: 'desk',
        models: { L1: [model('flash'), model('alternative')], L2: [model('plan', 'replace')], L3: [model('exec', 'replace')] } },
      mesh: {nodeId:'local', stateDirectory:join(directory, 'mesh')},
    })
    const page = await host.client('/')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /<title>Prism · Chat<\/title>/)
    assert.equal(page.headers.get('content-language'), 'en')
    const nonce = /id="prism-browser" nonce="([^"]+)"/.exec(html)?.[1]
    assert.ok(nonce && page.headers.get('content-security-policy')?.includes(`'nonce-${nonce}'`))
    const [script, css] = await Promise.all([host.client('/prism/browser.js'), host.client('/prism/style.css')])
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /javascript/)
    assert.equal(css.status, 200)
    assert.match(await css.text(), /\.arco-btn/)
    assert.equal((await host.client('/api/workspaces')).status, 403)
    const api = '/prism/api'
    const initial = await host.client(api + '/view')
    assert.equal(initial.status, 200, host.diagnostic())
    assert.deepEqual((await initial.json()).models.map(m => m.id), ['flash', 'alternative'])
    assert.equal((await (await host.client(api + '/model', {modelId: 'alternative'})).json()).modelId, 'alternative')
    assert.equal((await host.client(api + '/model', {modelId:'plan'})).status, 400)
    assert.equal((await host.client(api + '/model', {modelId:'flash'})).status, 200)
    const input = {text: '请检查项目', requestId: 'same-input'}
    for (let n = 0; n < 2; n++) assert.equal((await host.client(api + '/message', input)).status, 200)
    let latest
    const view = await waitFor(async () => {
      latest = await (await host.client(api + '/view')).json()
      if (latest.messages.some(m => m.delivery === 'failed') || latest.tasks.some(task => task.status === 'failed')) {
        throw new Error(host.diagnostic() + '\n' + JSON.stringify(latest))
      }
      return latest.messages.some(m => m.text === completeText) ? latest : undefined
    }, () => host.diagnostic() + '\n' + JSON.stringify(latest), 40000)
    assert.deepEqual(view.messages.map(m => m.text), [input.text, explicitText, completeText])
    assert.equal(view.tasks.length, 2)
    assert.ok(view.tasks.every(task => task.status === 'completed'))
    assert.ok(!JSON.stringify(view).includes(directory))
    const task = view.tasks.find(task => task.parentId)
    const traceEndpoint = api + '/trace?task=' + encodeURIComponent(task.id)
    assert.equal((await host.client(traceEndpoint, {text: '禁止写入'})).status, 405)
    const transcript = await (await host.client(traceEndpoint)).json()
    assert.ok(transcript.some(entry => entry.text === privateText))
    const requests = (await readFile(host.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const expectedTools = {
      flash: ['dispatch_planner', 'get_progress', 'list_models', 'query_projects', 'send_child', 'send_user'],
      plan: ['dispatch_executor', 'get_progress', 'list_models', 'report_progress', 'send_child', 'send_parent'],
      exec: ['read', 'report_progress', 'send_parent'],
    }
    for (const request of requests) {
      assert.deepEqual(request.tools.sort(), expectedTools[request.model])
      const prompt = 'PROBE-PROMPT-' + request.model
      if (request.model === 'flash') {
        assert.ok(request.system.includes(prompt))
        assert.ok(request.system.trim().length > prompt.length)
      } else {
        assert.equal(request.system.trim(), prompt)
      }
      if (request.model !== 'exec') {
        for (const path of [desk, code]) {
          assert.ok(!request.system.includes(path), `${request.model} system exposes the workspace path`)
          assert.ok(!request.inputText.includes(path), `${request.model} inputs expose the workspace path`)
        }
      }
      assert.equal(request.exchange?.isError ?? false, false, request.exchange?.result)
    }
    assert.equal(new Set(requests.map(request => request.session)).size, 3)
    assert.ok(requests.some(request => request.exchange?.name === 'read' && request.exchange.result.includes('PROBE-EXECUTION-WORKSPACE')))
    const catalog = requests.find(request => request.exchange?.name === 'query_projects').exchange.result
    assert.ok(catalog.includes('TypeScript'))
    assert.ok(!catalog.includes(directory))
    assert.ok(requests.some(request => request.model === 'flash' && request.input === 'child_message'))
    assert.ok(requests.some(request => request.model === 'plan' && request.input === 'parent_message'))
  } finally {
    t.after(() => rm(directory, { recursive: true, force: true }))
  }
})
