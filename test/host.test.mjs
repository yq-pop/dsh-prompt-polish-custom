import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { TYPERT } from '../lib/typert.host.js'

function mount(overrides = {}, immediateTimeout = false) {
  let service, request, signal
  const timers = new Set()
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: {
      resolveModelInfo: async () => ({ id: 'm', context: { contextWindow: 8000 }, defaultMaxTokens: 600 }),
      async *stream(options) { request = options; signal = options.signal; yield { type: 'text-delta', text: '优化结果' }; yield { type: 'finish', reason: { kind: 'stop' } } },
    }, ...overrides,
  }
  services.llm.listProviders ??= () => [{ id: 'p', name: 'Provider' }, { id: 'other', name: 'Other' }]
  services.llm.listModels ??= async (provider) => [{ id: provider === 'p' ? 'm' : 'independent', name: 'Model' }]
  const cleanups = []
  apply({ get: (key) => services[key], provide: (_, value) => { service = value }, effect: (fn) => cleanups.push(fn()), timeout: (fn, delay) => { const id = setTimeout(fn, immediateTimeout ? 0 : delay); timers.add(id); return () => { clearTimeout(id); timers.delete(id) } } })
  return { service, get request() { return request }, get signal() { return signal }, timers, cleanups }
}
const args = { draft: '原始草稿', runId: 'r', options: { mode: 'precise', language: 'zh' } }
test('rc.2 lazy Typert codecs validate the six direct invocations', () => {
  assert.equal(TYPERT.invocations.length, 6)
  for (const method of TYPERT.invocations) {
    assert.equal(typeof method.parameters[0].codec.create, 'function')
    assert.deepEqual(method.parameters[0].codec.create().parse(args), args)
    assert.deepEqual(method.result.create().parse({ ok: true }), { ok: true })
  }
})
test('exact model capability resolution respects small output default and releases timers/stream', async () => {
  const h = mount()
  assert.deepEqual(await h.service.optimizePrompt(args), { ok: true, text: '优化结果', usedRoute: { provider: 'p', model: 'm', source: 'global' } })
  assert.equal(h.request.maxTokens, 600)
  assert.equal(h.signal.aborted, true)
  assert.equal(h.timers.size, 0)
  assert.equal((await h.service.cancelOptimize({ runId: 'r' })).ok, false)
})
test('selection failure becomes business error and does not leak run IDs', async () => {
  const h = mount({ agentDefaultModel: { currentSelection() { throw new Error('selection unavailable') } } })
  assert.match((await h.service.optimizePrompt(args)).error, /selection unavailable/)
  assert.equal((await h.service.cancelOptimize({ runId: 'r' })).ok, false)
})
test('cancellation returns promptly even when provider ignores AbortSignal', async () => {
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  let signal, closed = false
  const h = mount({ llm: { resolveModelInfo: async () => ({}), stream(options) { signal = options.signal; return { [Symbol.asyncIterator]() { return this }, next() { entered(); return new Promise(() => {}) }, return() { closed = true; return Promise.resolve({ done: true }) } } } } })
  const result = h.service.optimizePrompt(args)
  await started
  assert.equal((await h.service.cancelOptimize({ runId: 'r' })).ok, true)
  assert.equal((await result).cancelled, true)
  assert.equal(signal.aborted, true)
  assert.equal(closed, true)
  assert.equal(h.timers.size, 0)
})
test('idle timeout aborts and closes provider', async () => {
  let signal, closed = false
  const h = mount({ llm: { resolveModelInfo: async () => ({}), stream(options) { signal = options.signal; return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return() { closed = true; return Promise.resolve({ done: true }) } } } } }, true)
  assert.match((await h.service.optimizePrompt(args)).error, /超时/)
  assert.equal(signal.aborted, true)
  assert.equal(closed, true)
})
test('rc.2 terminal failure carries the provider diagnostic', async () => {
  const h = mount({ llm: { resolveModelInfo: async () => ({}), async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'provider unavailable' } } } } } })
  assert.equal((await h.service.optimizePrompt(args)).error, 'provider unavailable')
})
