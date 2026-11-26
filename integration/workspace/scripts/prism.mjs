import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const plugin = (id, config) => ({ id, name: join(root, id, 'dist', 'index.js'), config })

/** Relative project paths are relative to the operator's configuration, never model input. */
export function makePatch(config, directory = root) {
  const mesh = config.mesh ?? { nodeId: 'local' }
  const registry = structuredClone(config.registry)
  for (const entry of registry.projects ?? []) {
    if (entry.nodeId === mesh.nodeId) entry.workspace = resolve(directory, entry.workspace)
    else if (!isAbsolute(entry.workspace)) throw new Error('远程项目需要指定节点上的绝对路径')
  }
  if (registry.catalogFile) registry.catalogFile = resolve(directory, registry.catalogFile)
  const orchestrator = { ...config.orchestrator }
  if (orchestrator.stateDirectory) orchestrator.stateDirectory = resolve(directory, orchestrator.stateDirectory)
  const nativeTools = [
    { id: 'prism-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: true } },
    { id: 'prism-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'prism-bash', name: '@deepseek-ai/dsh-tool-bash' },
  ]
  return [{ insert: [
    ...['l1', 'l2', 'l3'].map(id => ({
      id: 'prism-preset-' + id, name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'prism-' + id, name: 'Prism ' + id.toUpperCase(), plugins: id === 'l3' ? nativeTools : [] },
    })),
    plugin('dsh-workspace-registry', registry), plugin('dsh-mesh-node', mesh),
    plugin('dsh-orchestrator', orchestrator), plugin('dsh-im-gateway', config.im ?? {}),
    plugin('dsh-concierge-ui', {}),
  ] }]
}

async function main() {
  const [input, ...options] = process.argv.slice(2)
  if (input === '--help') {
    console.log('npm start -- [prism.config.json] [dsh web 选项，例如 --host 127.0.0.1 --port 3080 --no-open]')
    return
  }
  const file = resolve(input ?? join(root, 'prism.example.json'))
  const patch = makePatch(JSON.parse(await readFile(file, 'utf8')), dirname(file))
  const temp = await mkdtemp(join(tmpdir(), 'dsh-prism-'))
  try {
    const overlay = join(temp, 'prism.patch.yml')
    await writeFile(overlay, JSON.stringify(patch), { mode: 0o600 })
    const cli = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib', 'bin.js')
    const child = spawn(process.execPath, [cli, 'web', '--patch', overlay, ...options], { stdio: 'inherit' })
    const forward = signal => child.kill(signal)
    const int = () => forward('SIGINT'), term = () => forward('SIGTERM')
    process.once('SIGINT', int)
    process.once('SIGTERM', term)
    try {
      process.exitCode = await new Promise((res, rej) => {
        child.once('error', rej)
        child.once('exit', (code, signal) => res(code ?? (signal === 'SIGINT' ? 130 : 143)))
      })
    } finally {
      process.off('SIGINT', int)
      process.off('SIGTERM', term)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
