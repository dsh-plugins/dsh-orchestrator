import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('all layers fork a locked formal DSH session, archive the source and resume the new binding', { timeout: 65_000 }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'prism-host-')))
  const cli = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
  const probe = fileURLToPath(new URL('./host-lock-probe.mjs', import.meta.url))
  const patch = join(dir, 'probe.yml')
  const presets = ['l1', 'l2', 'l3'].map(layer => ({
    id: 'lock-preset-' + layer, name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'prism-' + layer, plugins: layer === 'l3' ? [{ id: 'file-tools', name: '@deepseek-ai/dsh-tool-fs' }] : [] },
  }))
  await writeFile(patch, JSON.stringify([{ insert: [...presets, { id: 'lock-probe', name: probe, config: { directory: dir } }] }]))
  const proc = spawn(process.execPath, [cli, 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: dir, env: { ...process.env, DSH_HOME: join(dir, 'dsh'), DSH_AGENTS_HOME: join(dir, 'agents'), DSH_TELEMETRY_DISABLED: '1' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(proc, 'exit')
  let log = ''
  const diagnostic = () => log.replace(/https?:\/\/\S+/gu, '[URL]').slice(-5000)
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(diagnostic())), 55000)
      const check = chunk => {
        log += chunk.toString()
        if (log.includes('PRISM_LOCK_ERROR') || log.includes('PRISM_LOCK_OK')) {
          clearTimeout(deadline)
          if (log.includes('PRISM_LOCK_ERROR')) reject(new Error(diagnostic()))
          else resolve()
        }
      }
      proc.stdout.on('data', check)
      proc.stderr.on('data', check)
      void exited.then(() => {
        clearTimeout(deadline)
        reject(new Error(diagnostic()))
      }, reject)
    })
    assert.match(log, /PRISM_LOCK_OK/u)
  } finally {
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      process.kill(process.platform === 'win32' ? proc.pid : -proc.pid, 'SIGTERM')
    }
    await exited
    await rm(dir, { recursive: true, force: true })
  }
})
