// ci/align-package-manager.mjs 的单元测试：版本来源优先级 + 禁区判定。
// 运行: node tests/align-package-manager.test.mjs
import assert from 'node:assert/strict'
import { isAllowed, pickPnpmVersion } from '../ci/align-package-manager.mjs'

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('无覆盖时跟随上游 devDependencies.pnpm', () => {
  const picked = pickPnpmVersion({ declared: '11.28.5', pinned: '11.30.0' })
  assert.equal(picked.version, '11.28.5')
  assert.equal(picked.source, 'devDependencies.pnpm')
  assert.equal(picked.overridden, false)
})

test('没有 devDependencies.pnpm 时退回 packageManager', () => {
  const picked = pickPnpmVersion({ declared: '', pinned: '11.28.5' })
  assert.equal(picked.version, '11.28.5')
  assert.equal(picked.source, 'packageManager')
})

test('PNPM_VERSION 覆盖时以它为准，并标出偏差', () => {
  const picked = pickPnpmVersion({ override: '11.28.8', declared: '11.28.5' })
  assert.equal(picked.version, '11.28.8')
  assert.equal(picked.source, 'PNPM_VERSION')
  assert.equal(picked.overridden, true)
})

test('覆盖值与上游一致时不算偏差', () => {
  assert.equal(pickPnpmVersion({ override: '11.28.5', declared: '11.28.5' }).overridden, false)
})

test('三个来源都空必须报错', () => {
  const picked = pickPnpmVersion({})
  assert.ok('error' in picked)
  assert.match(picked.error, /PNPM_VERSION/)
})

test('无法解析的版本必须报错', () => {
  assert.ok('error' in pickPnpmVersion({ declared: 'latest' }))
  assert.ok('error' in pickPnpmVersion({ declared: '11' }))
})

test('禁区：11.7.0 及以下被拒（pnpm#12880）', () => {
  for (const version of ['11.7.0', '11.6.9', '10.34.9', '9.15.9']) assert.equal(isAllowed(version), false, version)
})

test('禁区：12.x 被拒（工作区 pnpm run 失败）', () => {
  for (const version of ['12.0.0', '12.15.0', '13.0.0']) assert.equal(isAllowed(version), false, version)
})

test('下界本身放行，11.x 尾部放行', () => {
  for (const version of ['11.7.1', '11.27.1', '11.28.5', '11.28.8']) assert.equal(isAllowed(version), true, version)
})

test('预发布后缀不影响判定', () => {
  assert.equal(isAllowed('11.28.5-rc.1'), true)
  assert.equal(isAllowed('12.0.0-rc.1'), false)
})

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  PASS ${name}`) } catch (error) { console.log(`  FAIL ${name}\n    ${error.message}`) }
}
console.log(`\n${passed}/${tests.length} 通过`)
if (passed !== tests.length) process.exit(1)
