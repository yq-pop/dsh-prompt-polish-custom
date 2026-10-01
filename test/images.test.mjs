import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { normalizeOptions } from '../lib/shared.js'
const image = { data: 'YWJj', mediaType: 'image/png', attachmentId: 'draft-image', region: { x: 0, y: 0, width: .5, height: 1 } }
function harness(modalities = ['text', 'image'], initialSettings = {}) {
  let service, request, inputs, stored = { ...initialSettings }, prepared, writes = 0
  const limits = { maxImagesPerMessage: 2, maxImageBytes: 10, maxMessageImageBytes: 15, mediaTypes: ['image/png'] }
  const stream = async function* (o) { request = o; yield { type: 'text-delta', text: 'result' } }
  apply({ get(key) { return {
    llm: { listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'vision' }], resolveModelInfo: async () => ({ inputModalities: modalities }), stream,
      prepareCall: async (config) => { prepared = config; return { config, inputModalities: modalities, stream(o) { for (const [k, v] of Object.entries(config)) assert.equal(o[k], v); return stream(o) } } } },
    attachments: { imageLimits: limits, saveImages: async (images) => { inputs = images; return images.map(() => ({ attachmentId: 'saved-image', mediaType: 'image/png', bytes: 3, width: 20, height: 10 })) } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'vision' }) },
    fs: { resolve: async (p) => p, readText: async () => JSON.stringify(stored), writeText: async (_, text) => { writes++; stored = JSON.parse(text) } },
  }[key] }, provide(_, s) { service = s }, effect() {}, timeout(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t) } })
  return { service, get request() { return request }, get inputs() { return inputs }, get prepared() { return prepared }, get stored() { return stored }, get writes() { return writes } }
}
test('image context defaults to off including old/invalid settings', () => { for (const s of [undefined, {}, { imageContext: 'bad' }]) assert.equal(normalizeOptions(s).imageContext, 'off') })
test('off ignores malicious images without reads, saves or image blocks', async () => { const h = harness(); assert.equal((await h.service.optimizePrompt({ draft: 'draft', images: [{ url: 'https://bad' }] })).ok, true); assert.equal(h.inputs, undefined); assert.equal(h.request.messages.at(-1).content.some((b) => b.type === 'image'), false) })
test('whole and marked use validated bytes and real image references on selected route', async () => { for (const imageContext of ['whole', 'marked']) { const h = harness(); const r = await h.service.optimizePrompt({ draft: 'draft', options: { imageContext, provider: 'p', model: 'vision' }, images: [image] }); assert.equal(r.ok, true); assert.deepEqual([...h.inputs[0].data], [97, 98, 99]); assert.equal(h.request.messages.at(-1).content.find((b) => b.type === 'image').attachment.attachmentId, 'saved-image'); assert.equal(h.request.model, 'vision'); assert.equal(h.prepared.maxTokens, h.request.maxTokens) } })
test('vision unsupported or unknown rejects explicitly before saving and dispatch', async () => { for (const modality of [['text'], []]) { const h = harness(modality); const r = await h.service.optimizePrompt({ draft: 'draft', options: { imageContext: 'whole' }, images: [image] }); assert.equal(r.ok, false); assert.match(r.error, /不支持图像/); assert.equal(h.inputs, undefined); assert.equal(h.request, undefined) } })
test('whole missing or empty images continues text-only on same route without vision preparation', async () => {
  for (const images of [undefined, []]) {
    const h = harness(['text']); const r = await h.service.optimizePrompt({ draft: 'draft', options: { imageContext: 'whole', provider: 'p', model: 'vision' }, images })
    assert.equal(r.ok, true); assert.equal(h.inputs, undefined); assert.equal(h.prepared, undefined)
    assert.equal(h.request.model, 'vision'); assert.equal(r.usedRoute.source, 'explicit')
    assert.equal(h.request.messages.at(-1).content.some((b) => b.type === 'image'), false)
  }
})
test('legacy marked normalizes to whole without requiring or sending region metadata', async () => {
  assert.equal(normalizeOptions({ imageContext: 'marked' }).imageContext, 'whole')
  const h = harness(); assert.equal((await h.service.optimizePrompt({ draft: 'draft', options: { imageContext: 'marked' }, images: [{ data: image.data, mediaType: image.mediaType }] })).ok, true)
  assert.equal(h.inputs[0].region, undefined)
})
test('off does not even access image payload', async () => {
  const h = harness(); const args = { draft: 'draft', options: { imageContext: 'off' }, get images() { throw new Error('must not read') } }
  assert.equal((await h.service.optimizePrompt(args)).ok, true)
})
test('limits and URL/path/noncanonical encodings reject before attachment save', async () => { for (const images of [null, {}, 'invalid', [{ ...image, data: 'https://invalid' }], [{ ...image, data: 'YQ=' }], [image, image, image], [{ ...image, data: Buffer.alloc(11).toString('base64') }]]) { const h = harness(); assert.equal((await h.service.optimizePrompt({ draft: 'draft', options: { imageContext: 'whole' }, images })).ok, false); assert.equal(h.inputs, undefined) } })
test('L3 image setting roundtrips without breaking route and legacy fields', async () => { const h = harness(); await h.service.setSettings({ root: '/workspace', patch: { imageContext: 'marked', provider: 'p', model: 'vision' } }); assert.equal((await h.service.getSettings({ root: '/workspace' })).settings.imageContext, 'whole') })

test('L3 legacy migration preserves raw storage until next explicit patch, retaining unknown fields', async () => {
  const h = harness(['text'], { imageContext: 'marked', provider: 'p', model: 'vision', custom: 'keep', unknown: { value: 1 } })
  const loaded = await h.service.getSettings({ root: '/workspace' })
  assert.equal(loaded.settings.imageContext, 'whole'); assert.equal(h.stored.imageContext, 'marked'); assert.equal(h.writes, 0)
  await h.service.setSettings({ root: '/workspace', patch: { language: 'en' } })
  assert.equal(h.stored.imageContext, 'whole'); assert.equal(h.stored.custom, 'keep'); assert.equal(h.stored.model, 'vision'); assert.deepEqual(h.stored.unknown, { value: 1 })
})
