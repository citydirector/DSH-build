// patch-desktop-node-runtime 回归测试：升级改对三处且只改三处、幂等、只升不降、哈希缺失/重复/锚点缺失必须报错。
// 运行: node tests/patch-desktop-node-runtime.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCK, compareVersions, fetchShasums, hashesFromShasums, patchDesktopNodeRuntime, planEdits } from '../portable/patch-desktop-node-runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const H = (c) => c.repeat(64)

/** 上游 lock.json 的形状（截取两个 target，保留 python / wheels 等不该被碰的字段）。 */
const LOCK_FIXTURE = [
  '{',
  '  "nodeVersion": "24.22.3",',
  '  "pythonVersion": "3.12.14",',
  '  "targets": {',
  '    "win-x64": {',
  '      "nodeArchive": "win-x64.zip",',
  `      "nodeSha256": "${H('a')}",`,
  '      "pythonTarget": "x86_64-pc-windows-msvc",',
  `      "pythonSha256": "${H('c')}",`,
  '      "wheels": [{ "url": "https://example.invalid/numpy.whl", "sha256": "' + H('d') + '" }]',
  '    },',
  '    "linux-x64": {',
  '      "nodeArchive": "linux-x64.tar.gz",',
  `      "nodeSha256": "${H('b')}",`,
  '      "pythonTarget": "x86_64-unknown-linux-gnu",',
  `      "pythonSha256": "${H('e')}",`,
  '      "wheels": []',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

const SHASUMS = [
  `${H('1')}  node-v26.13.1-win-x64.zip`,
  `${H('2')}  node-v26.13.1-linux-x64.tar.gz`,
  `${H('3')}  node-v26.13.1-win-x64.7z`,
  `${H('4')}  node-v26.13.1-darwin-arm64.tar.gz`,
  '',
].join('\n')

function tree(text = LOCK_FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-node-runtime-'))
  const path = join(root, LOCK)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return { root, read: () => readFileSync(path, 'utf8') }
}

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('升级：nodeVersion 与每个 target 的 nodeSha256 都换掉，其它行一字不动', () => {
  const t = tree()
  try {
    assert.equal(patchDesktopNodeRuntime(t.root, '26.13.1', SHASUMS).applied.length, 3)
    const after = t.read()
    const lock = JSON.parse(after)
    assert.equal(lock.nodeVersion, '26.13.1')
    assert.equal(lock.targets['win-x64'].nodeSha256, H('1'))
    assert.equal(lock.targets['linux-x64'].nodeSha256, H('2'))
    const before = LOCK_FIXTURE.split('\n')
    const changed = after.split('\n').filter((line, i) => line !== before[i])
    assert.equal(changed.length, 3, '只应改动三行')
    assert.deepEqual(Object.keys(lock.targets['win-x64']), Object.keys(JSON.parse(LOCK_FIXTURE).targets['win-x64']), '键顺序保持')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('幂等：已是目标版本时不写字节、也不需要哈希表', () => {
  const t = tree()
  try {
    patchDesktopNodeRuntime(t.root, '26.13.1', SHASUMS)
    const once = t.read()
    assert.equal(patchDesktopNodeRuntime(t.root, '26.13.1', '').applied.length, 0)
    assert.equal(t.read(), once)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('只升不降：构建用 Node 低于锁里的版本必须报错', () => {
  assert.throws(() => planEdits(LOCK_FIXTURE, '24.22.1', SHASUMS), /拒绝降级/)
  assert.equal(compareVersions('26.13.1', '24.22.3') > 0, true)
  assert.equal(compareVersions('v24.22.3', '24.22.3'), 0)
})

test('SHASUMS 里缺某个 target 的压缩包：报错', () => {
  const missing = SHASUMS.split('\n').filter((line) => !line.includes('linux-x64')).join('\n')
  assert.throws(() => planEdits(LOCK_FIXTURE, '26.13.1', missing), /linux-x64\.tar\.gz 应恰好 1 行，实际 0 行/)
})

test('SHASUMS 里同名压缩包重复：报错', () => {
  assert.throws(() => hashesFromShasums(SHASUMS + `${H('5')}  node-v26.13.1-win-x64.zip\n`, '26.13.1', ['win-x64.zip']), /实际 2 行/)
})

test('锚点缺失（上游改了 lock 的格式）：大声失败、不写字节', () => {
  const reformatted = LOCK_FIXTURE.replace(`"nodeSha256": "${H('b')}"`, `"nodeSha256":"${H('b')}"`)
  const t = tree(reformatted)
  try {
    assert.throws(() => patchDesktopNodeRuntime(t.root, '26.13.1', SHASUMS), /found 0/)
    assert.equal(t.read(), reformatted)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('不认识的版本写法一律报错', () => {
  assert.throws(() => planEdits(LOCK_FIXTURE, '26', SHASUMS), /只接受 X\.Y\.Z/)
  assert.throws(() => planEdits(LOCK_FIXTURE, '26.13.1-rc.1', SHASUMS), /只接受 X\.Y\.Z/)
})

test('fetchShasums：拼对官方地址，非 2xx 报错', async () => {
  const seen = []
  const okFetch = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => SHASUMS } }
  assert.equal(await fetchShasums('v26.13.1', okFetch), SHASUMS)
  assert.deepEqual(seen, ['https://nodejs.org/dist/v26.13.1/SHASUMS256.txt'])
  await assert.rejects(fetchShasums('26.13.1', async () => ({ ok: false, status: 404, text: async () => '' })), /HTTP 404/)
})

test('build-desktop.mjs 在源码补丁阶段调用了它', () => {
  const text = readFileSync(join(HERE, '..', 'portable', 'build-desktop.mjs'), 'utf8')
  const call = text.indexOf("'patch-desktop-node-runtime.mjs'")
  assert.ok(call > 0, '没有调用 patch-desktop-node-runtime.mjs')
  assert.ok(call > text.indexOf("'patch-desktop-update.mjs'"), '应排在其它源码补丁之后')
  assert.ok(call < text.indexOf("run('build'") || text.indexOf("run('build'") < 0, '必须早于构建')
})

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  PASS ${name}`) } catch (error) { console.log(`  FAIL ${name}\n    ${error.message}`) }
}
console.log(`\n${passed}/${tests.length} 通过`)
if (passed !== tests.length) process.exit(1)
