// portable/lib/apply-edits.mjs 的单元测试（node:test）。
// 运行: npm test（node --test "tests/*.test.mjs"）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEditsToText, countOccurrences } from '../portable/lib/apply-edits.mjs'

const edit = { name: 'e', from: 'a = 1\n', to: 'a = 2 // patched\n' }

test('applies a single-shape edit', () => {
  const r = applyEditsToText('x\na = 1\ny\n', [edit], 'L')
  assert.equal(r.text, 'x\na = 2 // patched\ny\n')
  assert.deepEqual(r.applied, ['e'])
})

test('is idempotent', () => {
  const once = applyEditsToText('a = 1\n', [edit], 'L').text
  const twice = applyEditsToText(once, [edit], 'L')
  assert.equal(twice.text, once)
  assert.deepEqual(twice.applied, [])
})

test('missing and duplicate anchors fail loudly with location', () => {
  assert.throws(() => applyEditsToText('nothing\n', [edit], 'L', 'f.ts'), /^Error: L: e: expected exactly 1 occurrence in f\.ts, found 0$/)
  assert.throws(() => applyEditsToText('a = 1\na = 1\n', [edit], 'L'), /found 2/)
})

test('multi-shape: exactly one known shape must match once', () => {
  const multi = { name: 'm', from: ['old\n', 'new\n'], to: 'patched\n' }
  assert.equal(applyEditsToText('new\n', [multi], 'L').text, 'patched\n')
  assert.throws(() => applyEditsToText('old\nnew\n', [multi], 'L'), /one known shape.*\[1, 1\]/)
  assert.throws(() => applyEditsToText('x\n', [multi], 'L'), /\[0, 0\]/)
})

test('replacement text is literal ($& is not expanded)', () => {
  const dollar = { name: 'd', from: 'X', to: 'cost: $& $1' }
  assert.equal(applyEditsToText('X', [dollar], 'L').text, 'cost: $& $1')
})

test('countOccurrences', () => {
  assert.equal(countOccurrences('aXbXc', 'X'), 2)
  assert.equal(countOccurrences('abc', 'X'), 0)
})
