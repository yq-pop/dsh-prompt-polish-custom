import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

async function clientHarness(initialSettings = {}, optimize, imageSupport = {}) {
  let plugin, cursor = 0, calls = [], mounted
  const state = [], slots = new Map(), effects = [], effectStates = []
  let effectCursor = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next }] },
    useRef(initial) { const [ref] = this.useState(() => ({ current: initial })); return ref },
    useMemo(fn) { return fn() }, useCallback(fn) { return fn }, useEffect(fn, deps) {
      const i = effectCursor++, old = effectStates[i]
      if (!old || !deps || deps.some((d, j) => d !== old.deps[j])) {
        effectStates[i] = { deps, cleanup: old?.cleanup }
        effects.push(() => { effectStates[i].cleanup?.(); effectStates[i].cleanup = fn() })
      }
    },
  }
  let saved = { withHistory: true, withToolResults: true, ...initialSettings }
  const events = new Map()
  const window = { Image: imageSupport.Image, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), addEventListener(name, fn) { events.set(name, fn) }, removeEventListener(name) { events.delete(name) }, dispatchEvent(e) { events.get(e.type)?.(e) }, localStorage: { getItem: () => JSON.stringify(saved), setItem(_, value) { saved = JSON.parse(value) } }, __ModuleLoader__: { load({ factory }) { plugin = factory(() => React) } } }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, document: { createElement: imageSupport.createElement, querySelector: () => ({}), addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout, Map, Set, Date, CustomEvent: class { constructor(type, data) { this.type = type; Object.assign(this, data) } } })
  const api = Object.fromEntries(['getSettings', 'setSettings', 'optimizePrompt', 'cancelOptimize', 'listModels', 'listRoutes'].map((method) => [method, async (payload) => { calls.push({ method, payload }); if (method === 'optimizePrompt' && optimize) return { ok: true, value: await optimize(payload) }; return { ok: true, value: method === 'optimizePrompt' ? { ok: true, text: 'polished' } : method === 'getSettings' && imageSupport.hostSettings ? { ok: true, settings: imageSupport.hostSettings } : method === 'listModels' ? { ok: true, routes: [{ provider: 'a', model: 'one', name: 'One' }, { provider: 'b', model: 'two', name: 'Two' }], defaultRoute: { provider: 'a', model: 'one' } } : { ok: true } } }]))
  await plugin.apply({ get(key) { return { slots: { inject(_, fn) { fn() }, register(meta, render) { slots.set(meta.name, render) } }, remote: { async $mount(c) { mounted = c; return () => {} } }, 'remote.promptPolish': api, workspaces: imageSupport.hostSettings ? { list: { getSnapshot: () => ({ items: [] }) } } : undefined, sessions: imageSupport.hostSettings ? { list: { getSnapshot: () => ({ byId: { s: { id: 's', cwd: '/workspace', retainedBy: { mainView: 1 } } } }) } } : undefined, conversation: { blocks: { set() {} }, resolveDraftAttachments: imageSupport.resolveDraftAttachments || (() => { throw new Error('must not read images') }) } }[key] }, effect() {} })
  let draft = 'draft', written, attachmentIds = []
  const nodes = [{ kind: 'user', content: [{ type: 'text', text: 'prior context' }] }, { kind: 'assistant', blocks: [{ kind: 'text', text: 'answer' }] }]
  const props = {
    sessionId: 's', inputActions: { setDraft(value) { written = value; draft = value } },
    useInput(selector) { assert.equal(typeof selector, 'function'); return selector({ draft, attachmentIds, occurrences: [] }) },
    useSession(selector) { assert.equal(typeof selector, 'function'); return selector({ removed: false }) },
    useChat(selector) { return selector({ legacy: { nodes } }) },
    useProjection(key, selector) { assert.equal(typeof selector, 'function'); return selector(key === 'todos' ? [{ content: 'todo context', status: 'pending' }] : { goal: { objective: 'goal context', phase: 'active' } }) },
  }
  const element = slots.get('conversation.input.left')(props)
  return { mounted, calls, slots, effects, get saved() { return saved }, changeSettings(patch) { saved = { ...saved, ...patch }; events.get('ptopt:settings-changed')?.({ detail: saved }) }, render() { cursor = 0; effectCursor = 0; return element.type(props) }, flushEffects() { for (const effect of effects.splice(0)) effect() }, unmount() { for (const effect of effectStates) effect?.cleanup?.() }, set attachmentIds(value) { attachmentIds = value }, set sessionId(value) { props.sessionId = value }, set draft(value) { draft = value }, get draft() { return draft }, get written() { return written } }
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of (node.children || []).flat(Infinity)) { const found = find(child, predicate); if (found) return found }
}
const button = (tree, label) => find(tree, (node) => node.type === 'button' && node.children.includes(label))

test('both settings surfaces list routes, save L1 fields and submit the selected independent route', async () => {
  const h = await clientHarness()
  const tree = h.render()
  find(tree, (n) => n.props.title === '提示词优化设置').props.onClick()
  let panel = h.render()
  let select = find(panel, (n) => n.type === 'select' && n.props['aria-label'] === '优化模型')
  assert.equal(select.props.value, '')
  for (const effect of h.effects.splice(0)) effect()
  await new Promise(setImmediate)
  panel = h.render()
  select = find(panel, (n) => n.type === 'select' && n.props['aria-label'] === '优化模型')
  assert.ok(find(select, (n) => n.type === 'option' && n.props.value === '["b","two"]'))
  select.props.onChange({ target: { value: '["b","two"]' } })
  assert.equal(h.saved.provider, 'b'); assert.equal(h.saved.model, 'two'); assert.equal(h.saved.withHistory, true)
  button(h.render(), '打开完整设置').props.onClick()
  select = find(h.render(), (n) => n.type === 'select' && n.props['aria-label'] === '优化模型')
  assert.equal(select.props.value, '["b","two"]')
  button(h.render(), '优化').props.onClick()
  await new Promise(setImmediate)
  assert.equal(h.calls.find((c) => c.method === 'optimizePrompt').payload.options.model, 'two')
})

test('rc.2 selector slots render a usable optimize control and send chat/goal context', async () => {
  const h = await clientHarness()
  assert.equal(h.slots.has('settings.general.item'), true)
  for (const d of h.mounted.descriptors) { assert.equal(typeof d.parameters[0].codec.create, 'function'); assert.equal(typeof d.result.create, 'function') }
  const tree = h.render()
  assert.equal(button(tree, '优化').props.disabled, undefined)
  button(tree, '优化').props.onClick()
  await new Promise(setImmediate)
  const request = h.calls.find((call) => call.method === 'optimizePrompt').payload
  assert.equal(request.draft, 'draft')
  assert.ok(request.history.some((item) => item.text === 'prior context'))
  assert.ok(request.history.some((item) => item.text.includes('goal context')))
  assert.ok(request.history.some((item) => item.text.includes('todo context')))
  const success = h.render()
  assert.equal(button(success, '采用优化结果').props.disabled, false)
  h.draft = 'changed after request'
  assert.equal(button(h.render(), '采用优化结果').props.disabled, true)
  h.draft = 'draft'
  button(h.render(), '采用优化结果').props.onClick()
  assert.equal(h.written, 'polished')
})

test('image settings default off and persist both surfaces; off never resolves image bytes', async () => {
  const h = await clientHarness(); mount(h)
  find(h.render(), (n) => n.props.title === '提示词优化设置').props.onClick()
  let field = find(h.render(), (n) => n.props['aria-label'] === '图像上下文')
  assert.equal(field.props.value, 'off'); field.props.onChange({ target: { value: 'whole' } }); assert.equal(h.saved.imageContext, 'whole')
  button(h.render(), '打开完整设置').props.onClick(); assert.equal(find(h.render(), (n) => n.props['aria-label'] === '图像上下文').props.value, 'whole')
  find(h.render(), (n) => n.props['aria-label'] === '图像上下文').props.onChange({ target: { value: 'off' } }); button(h.render(), '优化').props.onClick(); await new Promise(setImmediate)
  assert.equal(h.calls.find((c) => c.method === 'optimizePrompt').payload.images, undefined); h.unmount()
})
test('whole reads only resolved draft File bytes and sends the selected route', async () => {
  let ids
  const h = await clientHarness({ imageContext: 'whole', provider: 'b', model: 'two' }, undefined, { resolveDraftAttachments: (selected) => { ids = selected; return [{ kind: 'image', id: 'image', previewUrl: 'blob:local', file: { name: 'image.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([97, 98, 99]).buffer } }, { kind: 'file', id: 'file' }] } })
  h.attachmentIds = ['image', 'file']; button(mount(h), '优化').props.onClick(); await new Promise(setImmediate)
  assert.deepEqual(ids, ['image', 'file']); const request = h.calls.find((c) => c.method === 'optimizePrompt').payload
  assert.equal(request.images.length, 1); assert.equal(request.images[0].data, 'YWJj'); assert.equal(request.images[0].mediaType, 'image/png'); assert.equal(request.options.model, 'two'); h.unmount()
})
test('whole without images falls back only for this request, without warnings or settings changes', async () => {
  for (const attachmentIds of [[], ['file']]) {
    const h = await clientHarness({ imageContext: 'whole', provider: 'b', model: 'two' }, undefined, { resolveDraftAttachments: () => [{ kind: 'file', id: 'file' }] })
    h.attachmentIds = attachmentIds; button(mount(h), '优化').props.onClick(); await new Promise(setImmediate)
    const request = h.calls.find((c) => c.method === 'optimizePrompt').payload
    assert.equal(request.options.imageContext, 'off'); assert.equal(request.images, undefined)
    assert.equal(request.options.model, 'two'); assert.equal(h.saved.imageContext, 'whole')
    assert.equal(h.calls.some((c) => c.method === 'setSettings'), false)
    assert.ok(button(h.render(), '采用优化结果')); h.unmount()
  }
})
test('legacy marked loads as whole on both surfaces and persists only on next settings save', async () => {
  const h = await clientHarness({ imageContext: 'marked', provider: 'b', model: 'two', custom: 'keep' })
  mount(h); find(h.render(), (n) => n.props.title === '提示词优化设置').props.onClick()
  let field = find(h.render(), (n) => n.props['aria-label'] === '图像上下文')
  assert.equal(field.props.value, 'whole'); assert.equal(h.saved.imageContext, 'marked')
  assert.equal(find(field, (n) => n.type === 'option' && n.props.value === 'marked'), undefined)
  button(h.render(), '打开完整设置').props.onClick()
  assert.equal(find(h.render(), (n) => n.props['aria-label'] === '图像上下文').props.value, 'whole')
  find(h.render(), (n) => n.props['aria-label'] === '优化展示形式').props.onChange({ target: { value: 'replace' } })
  assert.equal(h.saved.imageContext, 'whole'); assert.equal(h.saved.custom, 'keep'); assert.equal(h.saved.model, 'two'); h.unmount()
})
test('legacy marked sends current whole File bytes, never preview URL or crop metadata', async () => {
  let bytes = [97, 98, 99]
  const h = await clientHarness({ imageContext: 'marked' }, undefined, { resolveDraftAttachments: () => [{ kind: 'image', id: 'image', previewUrl: 'blob:stale', file: { name: 'image.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array(bytes).buffer } }] })
  h.attachmentIds = ['image']; const tree = mount(h); bytes = [100, 101, 102]
  button(tree, '优化').props.onClick(); await new Promise(setImmediate)
  const request = h.calls.find((c) => c.method === 'optimizePrompt').payload
  assert.equal(request.options.imageContext, 'whole'); assert.equal(request.images[0].data, 'ZGVm')
  assert.equal(request.images[0].region, undefined); assert.equal(request.images[0].url, undefined)
  assert.equal(h.saved.imageContext, 'marked'); h.unmount()
})
test('attachment changes during request prevent replacement and invalidate preview even changed back', async () => {
  const d = deferred(), h = await clientHarness({ applyBehavior: 'replace' }, () => d.promise)
  button(mount(h), '优化').props.onClick(); h.attachmentIds = ['new']; h.render(); h.attachmentIds = []; h.render()
  d.resolve({ ok: true, text: 'polished' }); await new Promise(setImmediate)
  assert.equal(h.written, undefined); assert.equal(button(h.render(), '采用优化结果').props.disabled, true); h.unmount()
})
test('attachment changes permanently lose undo ownership without mutating attachments', async () => {
  const h = await clientHarness({ applyBehavior: 'replace' }); button(mount(h), '优化').props.onClick(); await new Promise(setImmediate)
  h.attachmentIds = ['new']; h.render(); h.attachmentIds = []; assert.equal(button(h.render(), '已优化'), undefined); h.unmount()
})
const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const mount = (h) => { h.render(); h.flushEffects(); return h.render() }

test('behavior field defaults preview in both surfaces and persists replace through L1/L2', async () => {
  const h = await clientHarness()
  mount(h)
  find(h.render(), (n) => n.props.title === '提示词优化设置').props.onClick()
  let field = find(h.render(), (n) => n.props['aria-label'] === '优化展示形式')
  assert.equal(field.props.value, 'preview')
  field.props.onChange({ target: { value: 'replace' } })
  assert.equal(h.saved.applyBehavior, 'replace')
  button(h.render(), '打开完整设置').props.onClick()
  assert.equal(find(h.render(), (n) => n.props['aria-label'] === '优化展示形式').props.value, 'replace')
  h.unmount()
})

test('replace yields green ownership, undo original then reoptimize with same selected model', async () => {
  const h = await clientHarness({ applyBehavior: 'replace', provider: 'b', model: 'two' })
  button(mount(h), '优化').props.onClick(); await settle()
  const green = button(h.render(), '已优化')
  assert.ok(green.props.className.includes('is-applied')); assert.equal(h.draft, 'polished')
  assert.equal(button(h.render(), '采用优化结果'), undefined)
  green.props.onClick(); assert.equal(h.draft, 'draft')
  button(h.render(), '优化').props.onClick(); await settle()
  assert.equal(h.draft, 'polished')
  const calls = h.calls.filter((c) => c.method === 'optimizePrompt')
  assert.equal(calls.length, 2); assert.equal(calls[1].payload.draft, 'draft')
  assert.equal(calls[1].payload.options.model, 'two'); h.unmount()
})

test('manual edits permanently invalidate green undo, including changing text back', async () => {
  const h = await clientHarness({ applyBehavior: 'replace' })
  button(mount(h), '优化').props.onClick(); await settle()
  const stale = button(h.render(), '已优化')
  h.draft = 'manual'; h.render(); h.draft = 'polished'; h.render()
  assert.equal(button(h.render(), '已优化'), undefined)
  stale.props.onClick(); assert.notEqual(h.draft, 'draft'); await settle(); h.unmount()
})

test('changed draft during replacement request is not overwritten, result remains preview/history', async () => {
  const d = deferred(), h = await clientHarness({ applyBehavior: 'replace' }, () => d.promise)
  button(mount(h), '优化').props.onClick(); h.draft = 'manual'; h.render()
  d.resolve({ ok: true, text: 'polished' }); await settle()
  assert.equal(h.draft, 'manual'); assert.equal(h.written, undefined)
  assert.equal(button(h.render(), '采用优化结果').props.disabled, true); h.unmount()
})

for (const applyBehavior of ['preview', 'replace']) test('request snapshots behavior: ' + applyBehavior, async () => {
  const d = deferred(), h = await clientHarness({ applyBehavior }, () => d.promise)
  button(mount(h), '优化').props.onClick()
  h.changeSettings({ applyBehavior: applyBehavior === 'replace' ? 'preview' : 'replace' }); h.render()
  d.resolve({ ok: true, text: 'polished' }); await settle()
  assert.equal(h.draft, applyBehavior === 'replace' ? 'polished' : 'draft')
  assert.equal(!!button(h.render(), '采用优化结果'), applyBehavior === 'preview'); h.unmount()
})

for (const action of ['cancel', 'session', 'unmount']) test(action + ' discards late replacement without covering draft', async () => {
  const d = deferred(), h = await clientHarness({ applyBehavior: 'replace' }, () => d.promise)
  button(mount(h), '优化').props.onClick()
  if (action === 'cancel') button(h.render(), '停止优化').props.onClick()
  else if (action === 'session') { h.sessionId = 'other'; h.draft = 'other draft'; h.render(); h.flushEffects() }
  else h.unmount()
  d.resolve({ ok: true, text: 'late' }); await settle()
  assert.equal(h.written, undefined); assert.ok(h.calls.some((c) => c.method === 'cancelOptimize'))
  assert.equal(button(h.render(), '已优化'), undefined); h.unmount()
})

test('errors do not overwrite and session switching clears applied state/history', async () => {
  const fail = await clientHarness({ applyBehavior: 'replace' }, async () => ({ ok: false, error: 'broken' }))
  button(mount(fail), '优化').props.onClick(); await settle(); assert.equal(fail.written, undefined); fail.unmount()
  const h = await clientHarness({ applyBehavior: 'replace' })
  button(mount(h), '优化').props.onClick(); await settle(); assert.ok(button(h.render(), '已优化'))
  h.sessionId = 'other'; h.render(); h.flushEffects(); assert.equal(button(h.render(), '已优化'), undefined)
  h.sessionId = 's'; h.render(); h.flushEffects(); assert.equal(button(h.render(), '已优化'), undefined); h.unmount()
})

test('L3 startup migration syncs both views in memory without rewriting L1 or L3', async () => {
  const h = await clientHarness({ imageContext: 'off', unknown: 'keep' }, undefined, { hostSettings: { imageContext: 'marked', provider: 'b', model: 'two' } })
  mount(h); await settle()
  find(h.render(), (n) => n.props.title === '提示词优化设置').props.onClick()
  assert.equal(find(h.render(), (n) => n.props['aria-label'] === '图像上下文').props.value, 'whole')
  assert.equal(h.saved.imageContext, 'off'); assert.equal(h.calls.some((c) => c.method === 'setSettings'), false)
  find(h.render(), (n) => n.props['aria-label'] === '优化展示形式').props.onChange({ target: { value: 'replace' } })
  assert.equal(h.saved.imageContext, 'whole'); assert.equal(h.saved.unknown, 'keep'); assert.equal(h.saved.model, 'two')
  const patch = h.calls.find((c) => c.method === 'setSettings').payload.patch
  assert.equal(patch.imageContext, 'whole'); assert.equal(patch.model, 'two'); h.unmount()
})
