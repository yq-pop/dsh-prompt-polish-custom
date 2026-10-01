import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
const tick = () => new Promise(setImmediate)
const defaults = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
function llm() {
  const stream = async function* () { yield { type: 'text-delta', text: 'polished' } }
  return { listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }), stream, prepareCall: async (config) => ({ config, inputModalities: ['image'], stream }) }
}
function root(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('timer', { timeout(fn, ms) { const id = setTimeout(fn, ms); return () => clearTimeout(id) } })
  ctx.mixin('timer', ['timeout'])
  return ctx
}

test('legacy timer-only apply captures missing llm permanently after late service appears', async (t) => {
  const ctx = root(t)
  // Reconstruct the pre-fix contract rather than asserting source substrings.
  let captured
  await ctx.plugin({ inject: ['timer'], apply(child) { const model = child.get('llm'); captured = () => model } })
  assert.equal(captured(), undefined)
  ctx.provide('llm', llm()); await tick()
  assert.ok(ctx.get('llm'))
  assert.equal(captured(), undefined)
})

test('real Cordis gates plugin apply until llm AND default model exist, then publishes working RPC', async (t) => {
  const ctx = root(t)
  ctx.plugin(plugin)
  await tick(); assert.equal(ctx.get('promptPolish'), undefined)
  const removeLlm = ctx.provide('llm', llm())
  await tick(); assert.equal(ctx.get('promptPolish'), undefined)
  ctx.provide('agentDefaultModel', defaults)
  await tick(); assert.ok(ctx.get('promptPolish'))
  assert.equal((await ctx.get('promptPolish').optimizePrompt({ draft: 'draft' })).ok, true)
  removeLlm(); await tick(); assert.equal(ctx.get('promptPolish'), undefined)
  ctx.provide('llm', llm()); await tick()
  assert.equal((await ctx.get('promptPolish').listModels()).ok, true)
})

test('hard injection respects isolated llm scope instead of using an unrelated root service', async (t) => {
  const ctx = root(t)
  ctx.provide('llm', llm()); ctx.provide('agentDefaultModel', defaults)
  const scoped = ctx.isolate('llm').isolate('promptPolish')
  scoped.plugin(plugin)
  await tick(); assert.equal(scoped.get('promptPolish'), undefined)
  scoped.provide('llm', llm())
  await tick(); assert.equal((await scoped.get('promptPolish').listModels()).ok, true)
  assert.equal(ctx.get('promptPolish'), undefined)
})

test('late optional fs/attachments/policy/sessions are read per invocation and replacements work', async (t) => {
  const ctx = root(t)
  ctx.provide('llm', llm()); ctx.provide('agentDefaultModel', defaults)
  await ctx.plugin(plugin)
  const service = ctx.get('promptPolish')
  assert.equal((await service.getSettings({ root: '/workspace' })).ok, false)
  let stored = '{}', policyArg, writePolicy
  const removeFs = ctx.provide('fs', { resolve: async (p) => p, readText: async () => stored, writeText: async (_, text, a, b, policy) => { stored = text; writePolicy = policy } })
  const session = { id: 's' }
  ctx.provide('sessions', { get: () => session })
  ctx.provide('sandboxPolicy', { resolve(args) { policyArg = args; return { mode: 'test' } } })
  assert.equal((await service.setSettings({ root: '/workspace', sessionId: 's', patch: { custom: 'keep' } })).ok, true)
  assert.equal(policyArg.session, session); assert.equal(writePolicy.mode, 'test')
  assert.equal((await service.getSettings({ root: '/workspace' })).settings.custom, 'keep')
  removeFs(); assert.equal((await service.getSettings({ root: '/workspace' })).ok, false)
  ctx.provide('fs', { resolve: async (p) => p, readText: async () => '{"custom":"replacement"}' })
  assert.equal((await service.getSettings({ root: '/workspace' })).settings.custom, 'replacement')
  let saves = 0
  ctx.provide('attachments', { imageLimits: { maxImagesPerMessage: 1, maxImageBytes: 10, maxMessageImageBytes: 10, mediaTypes: ['image/png'] }, saveImages: async () => { saves++; return [{ attachmentId: 'image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }] } })
  assert.equal((await service.optimizePrompt({ draft: 'draft', options: { imageContext: 'whole' }, images: [{ mediaType: 'image/png', data: 'YWJj' }] })).ok, true)
  assert.equal(saves, 1)
  assert.equal((await service.optimizePrompt({ draft: 'draft', get images() { throw new Error('off must not read images') } })).ok, true)
  assert.equal(saves, 1)
})

test('opaque surface override follows official resolved body palette, not translucent tokens or OS', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const override = source.slice(source.indexOf('/* Opaque plugin-local surfaces:'))
  assert.match(override, /body\[data-ds-dark-theme\] \.dyn-opt-root/)
  for (const value of ['#f5f6f7', '#fff', '#232325', '#29292c', '#1c1c1e']) assert.ok(override.includes(value))
  assert.match(override, /\.dyn-opt-pop, \.dyn-opt-result, \.dyn-opt-dialog, \.dyn-opt-chip\s*\{\s*background:var\(--pp-surface-raised\)/)
  assert.doesNotMatch(override.split('const cssTagId')[0], /--dsw-|prefers-color-scheme|transparent/)
})
