import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const { workspaces } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const files = []
for (const dir of ['test', ...workspaces.flatMap(base => [base + '/test', base + '/dist'])]) {
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir)) {
    if (/\.test\.m?js$/.test(file)) files.push(dir + '/' + file)
  }
}
const testArgs = process.platform === 'win32' ? ['--test', '--test-concurrency=1'] : ['--test']
const result = spawnSync(process.execPath, [...testArgs, ...files], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
