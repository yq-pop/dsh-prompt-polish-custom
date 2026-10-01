import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { normalizeOptions } from '../lib/shared.js'

function mount(selection = { provider: 'a', model: 'one' }) {
  let service, request, stored = { mode: 'structured', custom: 'legacy', unknown: 42 }
  const ctx = {
    get(key) { return {
      agentDefaultModel: { currentSelection: () => selection },
      llm: {
        listProviders: () => [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
        listModels: async (p) => [{ id: p === 'a' ? 'one' : 'two', name: 'Name' }],
        resolveModelInfo: async () => ({}),
        async *stream(o) { request = o; yield { type: 'text-delta', text: 'result' } },
      },
      fs: { resolve: async (p) => p, readText: async () => JSON.stringify(stored), writeText: async (_, text) => { stored = JSON.parse(text) } },
    }[key] },
    provide(_, s) { service = s }, effect() {},
    timeout(fn, ms) { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  }
  apply(ctx)
  return { service, get request() { return request }, get stored() { return stored } }
}
test('directory contains every configured provider/model and global default, alias matches', async () => {
  const h = mount(), d = await h.service.listModels({})
  assert.deepEqual(d.routes.map((r) => [r.provider, r.model]), [['a', 'one'], ['b', 'two']])
  assert.deepEqual(d.defaultRoute, { provider: 'a', model: 'one' })
  assert.deepEqual(await h.service.listRoutes({}), d)
})
test('explicit route overrides global and usedRoute matches actual dispatch', async () => {
  const h = mount(), result = await h.service.optimizePrompt({ draft: 'draft', options: { provider: 'b', model: 'two' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.usedRoute, { provider: 'b', model: 'two', source: 'explicit' })
  assert.equal(h.request.provider, 'b'); assert.equal(h.request.model, 'two')
})
test('legacy settings and cleared route follow global; missing default never chooses first route', async () => {
  for (const options of [undefined, { provider: '', model: '' }]) {
    const h = mount(), result = await h.service.optimizePrompt({ draft: 'draft', options })
    assert.equal(result.usedRoute.source, 'global'); assert.equal(h.request.model, 'one')
  }
  const h = mount(null)
  assert.match((await h.service.optimizePrompt({ draft: 'draft' })).error, /全局默认/)
  assert.equal(h.request, undefined)
})
test('incomplete and stale explicit routes reject before stream, without fallback', async () => {
  for (const options of [{ provider: 'b' }, { model: 'two' }, { provider: 'missing', model: 'two' }, { provider: 'b', model: 'deleted' }]) {
    const h = mount(), result = await h.service.optimizePrompt({ draft: 'draft', options })
    assert.equal(result.ok, false); assert.match(result.error, /不完整|失效|未配置/)
    assert.equal(h.request, undefined)
  }
})
test('normalization retains route halves, trims names and keeps legacy options', () => {
  const n = normalizeOptions({ mode: 'code', custom: ' old ', provider: ' b ', model: ' two ' })
  assert.equal(n.provider, 'b'); assert.equal(n.model, 'two'); assert.equal(n.mode, 'code'); assert.equal(n.custom, 'old')
  assert.equal(normalizeOptions({ provider: 'b' }).provider, 'b')
  assert.equal(normalizeOptions({}).model, '')
})
test('L3 shallow persistence preserves legacy and unknown fields and roundtrips route', async () => {
  const h = mount()
  assert.equal((await h.service.setSettings({ root: '/workspace', patch: { provider: 'b', model: 'two' } })).ok, true)
  assert.deepEqual(h.stored, { mode: 'structured', custom: 'legacy', unknown: 42, provider: 'b', model: 'two' })
  assert.equal((await h.service.getSettings({ root: '/workspace' })).settings.model, 'two')
  assert.equal((await h.service.setSettings({ root: '/workspace', patch: { applyBehavior: 'replace' } })).ok, true)
  assert.equal((await h.service.getSettings({ root: '/workspace' })).settings.applyBehavior, 'replace')
  assert.equal(h.stored.model, 'two'); assert.equal(h.stored.custom, 'legacy')
})
