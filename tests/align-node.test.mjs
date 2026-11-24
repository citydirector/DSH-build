// ci/align-node.mjs 的单测 + workflow 里 Node 版本接线的守卫（node:test，零依赖）。
// 运行: node --test tests/align-node.test.mjs
//
// 两半：
//   1. 选版本 / 复核的纯函数：上游 `^24.22.3 || >=26.13.1` 选出 26 / 26.13.1，各种覆盖值与
//      不认识的写法要么得到确定结果、要么报错，绝不猜。
//   2. build-harness.yml 的文本守卫：每个 setup-node 都必须吃 align-node 的输出并 check-latest，
//      每个装 node 的 job 都必须在装完后 --assert。防止有人顺手把 `node-version: "24"` 写回来 ——
//      那正是 0.2.3-alpha.2 收紧 engines 时差点用错 Node 的原因（runner 缓存版本侥幸是 24.22.3）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkRuntime, main, parseEngines, pickNode } from '../ci/align-node.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = '^24.22.3 || >=26.13.1'

test('上游当前的 engines：选主版本最高的 >=26.13.1 那一支', () => {
  assert.deepEqual(pickNode({ engines: UPSTREAM }), { major: 26, floor: '26.13.1', source: 'engines.node', branch: '>=26.13.1' })
})

test('只有一支 ^ 时就用它', () => {
  assert.deepEqual(pickNode({ engines: '^24.22.3' }), { major: 24, floor: '24.22.3', source: 'engines.node', branch: '^24.22.3' })
})

test('分支顺序不影响结果', () => {
  assert.equal(pickNode({ engines: '>=26.13.1 || ^24.22.3' }).major, 26)
})

test('不认识的写法一律报错，不猜', () => {
  for (const range of ['~24.22.3', '24.x', '>=24 <27', '<=26.0.0', '>=24.9', '^0.12.0']) {
    const result = parseEngines(range)
    assert.ok('error' in result, `应拒绝 ${range}`)
  }
})

test('没有 engines 又没有覆盖值：报错并提示 NODE_VERSION', () => {
  const result = pickNode({ engines: '' })
  assert.ok('error' in result)
  assert.match(result.error, /NODE_VERSION/u)
})

test('覆盖为主版本号：必须落在某条允许的主线上', () => {
  assert.deepEqual(pickNode({ engines: UPSTREAM, override: '24' }), { major: 24, floor: '24.22.3', source: 'NODE_VERSION', branch: '^24.22.3' })
  assert.deepEqual(pickNode({ engines: UPSTREAM, override: '26' }), { major: 26, floor: '26.13.1', source: 'NODE_VERSION', branch: '>=26.13.1' })
  // >= 分支向上开放：28 允许，下限取 28.0.0
  assert.deepEqual(pickNode({ engines: UPSTREAM, override: '28' }), { major: 28, floor: '28.0.0', source: 'NODE_VERSION', branch: '>=26.13.1' })
  assert.ok('error' in pickNode({ engines: UPSTREAM, override: '25' }), '25 不在任何一支上')
  assert.ok('error' in pickNode({ engines: UPSTREAM, override: '22' }))
})

test('覆盖为完整版本号：必须满足 engines，下限就是它本身', () => {
  assert.deepEqual(pickNode({ engines: UPSTREAM, override: '24.22.5' }), { major: 24, floor: '24.22.5', source: 'NODE_VERSION', branch: '^24.22.3' })
  assert.ok('error' in pickNode({ engines: UPSTREAM, override: '24.22.1' }), '低于 24.22.3 的 24 必须拒绝')
  assert.ok('error' in pickNode({ engines: UPSTREAM, override: '26.12.1' }), '低于 26.13.1 的 26 必须拒绝')
  assert.ok('error' in pickNode({ engines: UPSTREAM, override: 'lts' }), '无法解析的值必须拒绝')
})

test('复核：同一主线且不低于下限才通过', () => {
  const picked = pickNode({ engines: UPSTREAM })
  assert.equal(checkRuntime(picked, 'v26.13.1'), undefined)
  assert.equal(checkRuntime(picked, 'v26.14.0'), undefined)
  assert.match(checkRuntime(picked, 'v26.12.1'), /低于下限/u)
  // 24.22.3 本身满足 engines，但不是我们选的主线 —— setup-node 没按预期装，照样算错
  assert.match(checkRuntime(picked, 'v24.22.3'), /不在选定的主线/u)
  assert.match(checkRuntime(picked, 'v27.0.0'), /不在选定的主线/u)
  assert.match(checkRuntime(picked, 'garbage'), /无法解析/u)
})

test('main：写 GITHUB_OUTPUT，--assert 用退出码表态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'align-node-'))
  try {
    const manifestPath = join(dir, 'package.json')
    const output = join(dir, 'out.txt')
    writeFileSync(manifestPath, JSON.stringify({ engines: { node: UPSTREAM } }))
    writeFileSync(output, '')
    const quiet = { log: () => {}, error: () => {} }
    assert.equal(main({ argv: [], env: { GITHUB_OUTPUT: output }, manifestPath, ...quiet }), 0)
    assert.equal(readFileSync(output, 'utf8'), 'node_version=26\nnode_floor=26.13.1\n')
    assert.equal(main({ argv: ['--assert'], env: {}, manifestPath, runningVersion: 'v26.13.1', ...quiet }), 0)
    assert.equal(main({ argv: ['--assert'], env: {}, manifestPath, runningVersion: 'v24.22.1', ...quiet }), 2)
    // 覆盖值不合法：选版本阶段就失败，不写输出
    writeFileSync(output, '')
    assert.equal(main({ argv: [], env: { GITHUB_OUTPUT: output, NODE_VERSION: '25' }, manifestPath, ...quiet }), 2)
    assert.equal(readFileSync(output, 'utf8'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- workflow 守卫 ----

const LINES = readFileSync(join(ROOT, '.github', 'workflows', 'build-harness.yml'), 'utf8').split(/\r?\n/u)

/** 切出所有 job（两级缩进的 key），返回 name → 行数组。 */
function jobs() {
  const start = LINES.indexOf('jobs:')
  assert.notEqual(start, -1)
  const result = new Map()
  let current
  for (const line of LINES.slice(start + 1)) {
    const head = /^ {2}([A-Za-z][\w-]*):$/u.exec(line)
    if (head !== null) { current = head[1]; result.set(current, []); continue }
    if (current !== undefined) result.get(current).push(line)
  }
  return result
}

test('每个 setup-node 都吃 align-node 的输出并 check-latest', () => {
  let seen = 0
  for (const [name, lines] of jobs()) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!/uses: actions\/setup-node@/u.test(lines[index])) continue
      seen += 1
      const block = []
      for (let cursor = index + 1; cursor < lines.length && !/^ {6}- /u.test(lines[cursor]); cursor += 1) block.push(lines[cursor].trim())
      assert.ok(block.includes('node-version: ${{ steps.align-node.outputs.node_version }}'), `${name}: setup-node 的 node-version 必须来自 align-node，实际 ${JSON.stringify(block)}`)
      assert.ok(block.includes('check-latest: true'), `${name}: setup-node 必须 check-latest（否则会用 runner 缓存里的旧补丁版）`)
      const pickIndex = lines.findIndex((line) => line.trim() === 'id: align-node')
      assert.ok(pickIndex !== -1 && pickIndex < index, `${name}: align-node 步骤必须排在 setup-node 之前`)
      const assertIndex = lines.findIndex((line) => line.trim() === 'run: node _build_repo/ci/align-node.mjs --assert')
      assert.ok(assertIndex > index, `${name}: 装完 node 之后必须 --assert`)
    }
  }
  assert.ok(seen >= 4, `应至少有 4 个 setup-node（cua-helper / npm / portable / desktop），实际 ${seen}`)
})

test('workflow 里不再出现手写的 node-version 数字', () => {
  const literal = LINES.filter((line) => /node-version:\s*["']?\d/u.test(line))
  assert.deepEqual(literal, [])
})

test('便携冒烟用随包 node.exe 复核 engines', () => {
  const smoke = readFileSync(join(ROOT, 'ci', 'portable', 'smoke-boot.ps1'), 'utf8')
  assert.match(smoke, /portable\\node\\node\.exe _build_repo\\ci\\align-node\.mjs --assert/u)
})
