// Behavior coverage lives with the client VM harness in client.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOptions } from '../lib/shared.js'

test('apply behavior normalization defaults old/invalid settings to preview', () => {
  for (const options of [undefined, {}, { applyBehavior: 'invalid' }]) assert.equal(normalizeOptions(options).applyBehavior, 'preview')
  assert.equal(normalizeOptions({ applyBehavior: 'replace', provider: 'b', model: 'two' }).applyBehavior, 'replace')
})
