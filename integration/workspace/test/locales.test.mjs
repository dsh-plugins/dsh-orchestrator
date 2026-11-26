import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const languages = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh']
const packages = ['dsh-workspace-registry', 'dsh-orchestrator', 'dsh-mesh-node', 'dsh-im-gateway', 'dsh-concierge-ui']

test('each plugin exports all eight DSH catalogs with complete translations and interpolation keys', () => {
  for (const name of packages) {
    const catalog = lang => require(`@dsh-prism/${name}/locale/${lang}.json`)
    const expected = catalog('en').messages
    for (const language of languages) {
      const { meta, messages } = catalog(language)
      assert.ok(meta.title.trim() && meta.description.trim(), `${name} ${language} metadata`)
      assert.deepEqual(Object.keys(messages).sort(), Object.keys(expected).sort(), `${name} ${language} keys`)
      for (const [key, text] of Object.entries(messages)) {
        assert.ok(text.trim(), `${name} ${language}.${key}`)
        assert.deepEqual((text.match(/\{\w+\}/g) ?? []).sort(), (expected[key].match(/\{\w+\}/g) ?? []).sort())
      }
    }
  }
})
