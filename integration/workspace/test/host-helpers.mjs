import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { makePatch } from '../scripts/prism.mjs'

const cli = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const fixture = fileURLToPath(new URL('./fixture-model.mjs', import.meta.url))

export async function waitFor(condition, failure, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await condition()
    if (result) return result
    await sleep(100)
  }
  throw new Error(await failure())
}

export function model(id, promptMode = 'append') {
  return { id, provider: 'prism-probe', promptMode, description: '能力介绍 ' + id, prompt: 'PROBE-PROMPT-' + id }
}

export async function startHost(t, directory, config, env = {}, fixtureConfig = {}) {
  const logFile = join(directory, 'requests.jsonl')
  const entries = makePatch(config, directory)
  entries.push({ insert: [{ id: 'model-probe', name: fixture, config: { ...fixtureConfig, logFile } }] })
  const patchPath = join(directory, 'integration.patch.yml')
  await writeFile(patchPath, JSON.stringify(entries))
  const proc = spawn(process.execPath, [cli, 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: directory, env: { ...process.env, ...env, DSH_HOME: join(directory, 'dsh'), DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(proc, 'exit')
  let log = ''
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', line => { log += line.toString() })
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM')
    const killer = setTimeout(() => proc.kill('SIGKILL'), 6000)
    try { await exited } finally { clearTimeout(killer) }
  })
  const diagnostic = () => log.replace(/https?:\/\/\S+/g, '[URL]').slice(-4000)
  const boot = await waitFor(() => {
    if (proc.exitCode !== null) throw new Error(diagnostic())
    return /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(log)?.[1]
  }, diagnostic, 60_000)
  const login = await fetch(boot, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'the DSH authentication exchange must grant a cookie')
  const origin = new URL(boot).origin
  const client = (path, body) => fetch(origin + path, body === undefined ? { headers: { cookie } } : {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-prism-request': '1' }, body: JSON.stringify(body),
  })
  return { client, diagnostic, origin, logFile }
}
