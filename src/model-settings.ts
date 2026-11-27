import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Layer, ModelRule, ModelRules } from './contracts.js'

type Config = Record<Layer, Volatile<ModelRule[]>>

declare module '@deepseek-ai/cordis' {
  interface Context {
    prismModelRules: () => ModelRules
  }
}

const modelRule = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  enabled: z.boolean().default(false),
  description: z.string().max(2000).default(''),
  prompt: z.string().max(16000).default(''),
})
const rules = z.array(modelRule).default([]).volatile()

export const name = 'dsh-prism-models'
export const Config = z.object({ L1: rules, L2: rules, L3: rules })

function validateRules(rules: ModelRules): void {
  for (const layer of ['L1', 'L2', 'L3'] as const) {
    const seen = new Set<string>()
    for (const rule of rules[layer]) {
      const key = JSON.stringify([rule.provider, rule.model])
      if (seen.has(key)) {
        throw new Error(layer + ' 包含重复的供应商模型')
      }
      seen.add(key)
    }
  }
}

function readRules(config: Config): ModelRules {
  return { L1: config.L1.get(), L2: config.L2.get(), L3: config.L3.get() }
}

export function apply(ctx: Context, config: Config): void {
  validateRules(readRules(config))
  ctx.inject(['settings'], scope => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('internal/config', (fiber, next) => {
    const raw = next()
    if (fiber === ctx.fiber) {
      validateRules(readRules(Config(raw)))
    }
    return raw
  })
  ctx.provide('prismModelRules', () => readRules(config))
}
