/**
 * `portable/patch-cua-ui-locate-bridge.mjs` 的测试。
 *
 * 2026-11-14 起这个脚本**不再改上游源码**（博士止损决定：撤销全部本地注入），只做两件事：
 *   1. 审计上游 CUA 源码是否仍是 pin 的原始形状（`--check`）；
 *   2. 算 `cua-windows/native` 整树摘要，作为 helper 的 build identity（`--digest`）。
 *
 * 所以测试覆盖的是这两件事，而不是「补丁打没打进去」：
 *   - 真实固定上游上必须干净——**不是喂自造假源码**。`UI_LOCATE_UPSTREAM` 指向的 checkout
 *     不存在时跳过并在输出里说明原因（不假绿）；CI 用 `UI_LOCATE_UPSTREAM=${{ github.workspace }}`。
 *   - 四类污染都要被指出来：多余文件、注入标识、文件缺失。
 *   - 摘要口径：形状、稳定性、跳过 bin/obj、随 `.cs` 改动变化、只收普通文件。
 *   - CLI 退出码：干净 0、污染 1、污染时 `--digest` 拒绝出值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkUpstream, hashNativeTree } from '../portable/patch-cua-ui-locate-bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const CLI = join(REPO, 'portable', 'patch-cua-ui-locate-bridge.mjs')
const UPSTREAM = process.env.UI_LOCATE_UPSTREAM ?? 'D:\\DSHWorkspace\\ui-locate\\_skadi_temp\\computer-use-audit\\upstream'

const CUA = 'packages/experimental/cua'
const WINDOWS = 'packages/experimental/cua-windows'
const haveUpstream = existsSync(join(UPSTREAM, CUA, 'src', 'index.ts')) && existsSync(join(UPSTREAM, WINDOWS, 'native', 'entry', 'Input.cs'))
const missingUpstream = `上游 checkout 不在：${UPSTREAM}（设 UI_LOCATE_UPSTREAM 指向固定上游再跑；缺树=跳过，不假绿）`

/**
 * 只把脚本会读的两棵子树 + 根 package.json 拷进临时镜像。
 * 全树没必要（上游几万文件），而脚本也只读这些。
 */
function mirror(t) {
  const root = mkdtempSync(join(REPO, '_skadi_temp', 'cua-bridge-'))
  mkdirSync(join(root, 'packages', 'experimental'), { recursive: true })
  cpSync(join(UPSTREAM, CUA), join(root, CUA), { recursive: true })
  cpSync(join(UPSTREAM, WINDOWS, 'native'), join(root, WINDOWS, 'native'), { recursive: true })
  cpSync(join(UPSTREAM, WINDOWS, 'src'), join(root, WINDOWS, 'src'), { recursive: true })
  cpSync(join(UPSTREAM, 'package.json'), join(root, 'package.json'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

/** 本机受限沙箱会以 EPERM 拒绝 spawn 子进程；那不是脚本的问题，但也绝不能算通过。 */
const spawnBlocked = (() => {
  const probe = cli('--help')
  return probe.error?.code === 'EPERM'
})()

test('真实固定上游：--check 干净，9 个文件全 pristine', { skip: haveUpstream ? false : missingUpstream }, () => {
  const { report, problems } = checkUpstream(UPSTREAM)
  assert.deepEqual(problems, [], 'pin 的上游不该有任何本地注入残留')
  assert.equal(report.length, 9)
  assert.ok(report.every((line) => line.endsWith(': pristine')), report.join('\n'))
})

test('多余文件（本地注入的整份源码）会被指出', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  writeFileSync(join(root, CUA, 'src', 'cua-dispatch.ts'), 'export const x = 1\n')
  const { problems } = checkUpstream(root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cua-dispatch\.ts: 文件存在/u)
})

test('注入标识会被指出（逐文件）', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const file = join(root, CUA, 'src', 'protocol.ts')
  writeFileSync(file, readFileSync(file, 'utf8') + "\n// deliveryMode\n")
  const { problems } = checkUpstream(root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /protocol\.ts: 含本地注入标识 deliveryMode/u)
})

test('缺文件会被指出，而不是当成干净', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  rmSync(join(root, WINDOWS, 'native', 'entry', 'Win32.cs'))
  const { problems } = checkUpstream(root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Win32\.cs: 文件缺失/u)
})

test('审计是只读的：跑两次结果一致、不改任何字节', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const before = readFileSync(join(root, CUA, 'src', 'index.ts'), 'utf8')
  const first = checkUpstream(root)
  const second = checkUpstream(root)
  assert.deepEqual(second, first)
  assert.equal(readFileSync(join(root, CUA, 'src', 'index.ts'), 'utf8'), before)
})

test('摘要形状：sha256: 前缀 + 64 位小写十六进制，逐文件同形状', { skip: haveUpstream ? false : missingUpstream }, () => {
  const { digest, files } = hashNativeTree(UPSTREAM)
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u)
  const keys = Object.keys(files)
  assert.ok(keys.length > 0)
  for (const key of keys) {
    assert.match(files[key], /^sha256:[0-9a-f]{64}$/u, key)
    assert.equal(key.includes('\\'), false, `键必须用 / 分隔：${key}`)
  }
})

test('摘要稳定：同一棵树两次相同', { skip: haveUpstream ? false : missingUpstream }, () => {
  assert.equal(hashNativeTree(UPSTREAM).digest, hashNativeTree(UPSTREAM).digest)
})

test('摘要随 native 源码变化：改一个 .cs 就必须变', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const before = hashNativeTree(root).digest
  const file = join(root, WINDOWS, 'native', 'entry', 'Input.cs')
  writeFileSync(file, readFileSync(file, 'utf8') + '\n// touched\n')
  assert.notEqual(hashNativeTree(root).digest, before, '改了 native 源码却得到同一个摘要 —— helper 的身份就失去意义')
})

test('摘要跳过 bin/obj：构建产物不进 build identity', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const before = hashNativeTree(root)
  mkdirSync(join(root, WINDOWS, 'native', 'bin', 'win-x64'), { recursive: true })
  mkdirSync(join(root, WINDOWS, 'native', 'obj', 'x'), { recursive: true })
  writeFileSync(join(root, WINDOWS, 'native', 'bin', 'win-x64', 'dsh-cua-windows.exe'), 'binary')
  writeFileSync(join(root, WINDOWS, 'native', 'obj', 'x', 'a.dll'), 'binary')
  const after = hashNativeTree(root)
  assert.equal(after.digest, before.digest)
  assert.deepEqual(Object.keys(after.files), Object.keys(before.files))
})

test('CLI：干净树 --check exit 0，污染树 exit 1', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  if (spawnBlocked) return t.skip('本机沙箱禁止 spawn 子进程（EPERM），CLI 退出码只能在 CI 上验证')

  const clean = cli(UPSTREAM, '--check')
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.stdout, /干净 — 0 pending/u)

  const root = mirror(t)
  writeFileSync(join(root, CUA, 'src', 'system-input-queue.ts'), 'export const y = 2\n')
  const dirty = cli(root, '--check')
  assert.equal(dirty.status, 1)
  assert.match(dirty.stderr, /污染 — /u)
})

test('CLI：污染树上 --digest 拒绝出值（不给半信半疑的摘要）', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  if (spawnBlocked) return t.skip('本机沙箱禁止 spawn 子进程（EPERM），CLI 退出码只能在 CI 上验证')

  const root = mirror(t)
  const file = join(root, WINDOWS, 'native', 'entry', 'Input.cs')
  writeFileSync(file, readFileSync(file, 'utf8') + '\n// ClickBackground\n')
  const result = cli(root, '--digest')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /拒绝在被污染的树上生成 native 摘要/u)
  assert.doesNotMatch(result.stdout, /"kind":"cua-helper-native-source"/u)
})