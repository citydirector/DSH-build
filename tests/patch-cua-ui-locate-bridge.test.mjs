/**
 * `portable/patch-cua-ui-locate-bridge.mjs` 的测试。
 *
 * 两件事必须被真实覆盖，否则这个补丁只有「看起来对」：
 *   1. **在真实固定上游上打**——不是喂一段自造的假源码。所有 patch 用例都从
 *      `UI_LOCATE_UPSTREAM`（默认 `D:\DSHWorkspace\ui-locate\_skadi_temp\computer-use-audit\upstream`）
 *      把目标文件拷进临时镜像再打补丁；上游 checkout 不在的机器（比如精简 CI）
 *      跳过并在输出里说清楚原因，而不是假绿。
 *   2. **补丁的失败形态**——锚点消失必须响亮失败，重复执行必须幂等，`--check`
 *      不得写盘。
 *
 * 另外直接跑注入的两个纯文件：`cua-dispatch-guard.ts`（伪造/过期上下文）与
 * `system-input-queue.ts`（有界排队、取消不执行）。它们刻意不 import 运行时模块，
 * 所以 Node 的类型擦除就能直接执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashNativeTree, patchCuaUiLocateBridge } from '../portable/patch-cua-ui-locate-bridge.mjs'
import { DispatchRejection, LiveDispatchRegistry, checkDispatch } from '../portable/cua-bridge-files/cua/cua-dispatch-guard.ts'
import { InputQueueFullError, MAX_WAITING_INPUTS, SystemInputQueue } from '../portable/cua-bridge-files/cua/system-input-queue.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const UPSTREAM = process.env.UI_LOCATE_UPSTREAM ?? 'D:\\DSHWorkspace\\ui-locate\\_skadi_temp\\computer-use-audit\\upstream'

/** 补丁会碰到的全部上游文件（镜像只拷这些，足以验证锚点）。 */
const TARGETS = [
  'packages/experimental/cua/src/index.ts',
  'packages/experimental/cua/src/protocol.ts',
  'packages/experimental/cua/src/types.ts',
  'packages/experimental/cua-windows/src/index.ts',
  'packages/experimental/cua-windows/src/guidance.ts',
  'packages/experimental/cua-windows/native/entry/Win32.cs',
  'packages/experimental/cua-windows/native/entry/DesktopExecutor.cs',
  'packages/experimental/cua-windows/native/entry/Input.cs',
]

const haveUpstream = existsSync(join(UPSTREAM, TARGETS[0])) && existsSync(join(UPSTREAM, TARGETS[7]))
const missingUpstream = `上游 checkout 不在：${UPSTREAM}（设 UI_LOCATE_UPSTREAM 指向固定上游再跑）`

/** 在仓内的临时目录里做一份镜像，测试结束删掉。 */
function mirror(t) {
  const dir = mkdtempSync(join(REPO, '_skadi_temp', 'patch-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const rel of TARGETS) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(UPSTREAM, rel), target)
  }
  return dir
}

/** 读镜像里打完补丁的文件。 */
const read = (root, rel) => readFileSync(join(root, rel), 'utf8')

// ── 真实上游上打补丁 ────────────────────────────────────────────────────────

test('patch：在真实固定上游上把三份注入文件与十一条编辑全部打进去', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const parts = patchCuaUiLocateBridge(root)
  assert.deepEqual(parts, [
    'packages/experimental/cua/src/index.ts: 4 edits',
    'packages/experimental/cua/src/protocol.ts: 1 edits',
    'packages/experimental/cua/src/types.ts: 1 edits',
    'packages/experimental/cua-windows/src/index.ts: 1 edits',
    'packages/experimental/cua-windows/src/guidance.ts: 1 edits',
    'packages/experimental/cua-windows/native/entry/Win32.cs: 1 edits',
    'packages/experimental/cua-windows/native/entry/DesktopExecutor.cs: 2 edits',
    'packages/experimental/cua-windows/native/entry/Input.cs: 2 edits',
  ])
  for (const name of ['cua-dispatch.ts', 'cua-dispatch-guard.ts', 'system-input-queue.ts']) {
    assert.ok(existsSync(join(root, 'packages/experimental/cua/src', name)), `${name} 必须被注入`)
  }
  // 分发面：同一 function、注册在 runtime effect 内、经 ctx.provide 撤销。
  const cua = read(root, 'packages/experimental/cua/src/index.ts')
  assert.match(cua, /import \{ installCuaDispatch \} from '\.\/cua-dispatch\.ts'/)
  assert.match(cua, /yield installCuaDispatch\(ctx, tool\)/)
  assert.match(cua, /deliveryModes/, 'getCapabilities 必须上报 deliveryModes')
  // 系统输入走共享队列：原 CUA 与 Host 桥接共用同一个入口。
  assert.match(cua, /systemInputQueue/)
  // click 契约扩展：schema 里出现 deliveryMode，且是 click 细分而非全局。
  const protocol = read(root, 'packages/experimental/cua/src/protocol.ts')
  assert.match(protocol, /deliveryMode/)
  // 能力声明。
  assert.match(read(root, 'packages/experimental/cua/src/types.ts'), /deliveryModes/)
  assert.match(read(root, 'packages/experimental/cua-windows/src/index.ts'), /deliveryModes/)
  assert.match(read(root, 'packages/experimental/cua-windows/src/guidance.ts'), /DELIVERY_GUIDANCE/)
  // 原生：PostMessage 声明 + 后台分支 + 白名单。
  const win32 = read(root, 'packages/experimental/cua-windows/native/entry/Win32.cs')
  assert.match(win32, /PostMessage/)
  assert.match(win32, /ScreenToClient/)
  assert.match(win32, /GetClassName/)
  const executor = read(root, 'packages/experimental/cua-windows/native/entry/DesktopExecutor.cs')
  assert.match(executor, /deliveryMode/)
  assert.match(executor, /ClickBackground/)
  const input = read(root, 'packages/experimental/cua-windows/native/entry/Input.cs')
  assert.match(input, /BACKGROUND_UNAVAILABLE/, '不支持后台的目标必须显式拒绝，不能静默升前台')
  assert.match(input, /BackgroundRootClasses/, '后台投递必须是白名单，不是黑名单')
  assert.match(input, /"#32770"/, '根窗口白名单必须点名标准对话框类')
  assert.match(input, /BackgroundControlClasses/)
  assert.match(input, /SysListView32/, '标准控件类要在白名单里')
  assert.match(input, /GetWindowThreadProcessId/, '命中窗口必须校验归属进程')
  assert.doesNotMatch(input, /BackgroundRejectedClasses/, '黑名单写法必须已经移除')
  assert.match(input, /using System\.Text;/)
})

test('patch：第二次执行是幂等的（0 edits，文件内容不变）', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  const before = TARGETS.map((rel) => read(root, rel))
  const parts = patchCuaUiLocateBridge(root)
  assert.ok(parts.every((line) => line.endsWith(': 0 edits')), parts.join(' | '))
  assert.deepEqual(TARGETS.map((rel) => read(root, rel)), before)
})

test('check：只读校验不写盘；打完补丁后全部 applied/present', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const pending = patchCuaUiLocateBridge(root, { check: true })
  assert.ok(pending.some((line) => line.endsWith(': to copy')), '未打补丁时应报告待注入文件')
  for (const rel of TARGETS) assert.equal(read(root, rel), readFileSync(join(UPSTREAM, rel), 'utf8'), `${rel} 不得被 check 改动`)

  patchCuaUiLocateBridge(root)
  const applied = patchCuaUiLocateBridge(root, { check: true })
  assert.ok(applied.every((line) => /: (applied|present)$/.test(line)), applied.join(' | '))
})

// ── 失败形态：必须响亮，不能悄悄放过 ───────────────────────────────────────

test('patch：锚点消失时响亮失败，且不写坏文件', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const anchor = 'yield installCuaTools(ctx, config, tool, guidance, programGuidance)'
  const file = join(root, 'packages/experimental/cua/src/index.ts')
  const original = readFileSync(file, 'utf8')
  assert.ok(original.includes(anchor))
  writeFileSync(file, original.replace(`    ${anchor}\n`, '    // anchor removed by test\n'))
  assert.throws(() => patchCuaUiLocateBridge(root), /expected exactly 1 occurrence/)
  assert.equal(readFileSync(file, 'utf8').includes('// anchor removed by test'), true, '失败后原文件保持原样')
})

test('patch：同一个锚点出现两次也拒绝（不能瞎猜打哪儿）', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const file = join(root, 'packages/experimental/cua/src/index.ts')
  const lines = readFileSync(file, 'utf8').split('\n')
  const at = lines.findIndex((line) => line.includes('yield installCuaTools(ctx, config, tool, guidance, programGuidance)'))
  assert.ok(at >= 0)
  // 复制「锚点 + 收尾」两行，制造出第二处完整匹配。
  const duplicated = lines.slice(at, at + 2).join('\n')
  writeFileSync(file, `${lines.join('\n')}\n${duplicated}\n`)
  assert.throws(() => patchCuaUiLocateBridge(root), /expected exactly 1 occurrence/)
})

test('patch：目标文件缺失即失败（根目录不对时不能假装成功）', (t) => {
  const dir = mkdtempSync(join(REPO, '_skadi_temp', 'patch-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => patchCuaUiLocateBridge(dir), /ENOENT|no such file/)
})

// ── helper 源码身份 ─────────────────────────────────────────────────────────

test('hashNativeTree：稳定、随 native 补丁变化、跳过 bin/obj', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  mkdirSync(join(root, 'packages/experimental/cua-windows/native/entry/bin/Debug'), { recursive: true })
  writeFileSync(join(root, 'packages/experimental/cua-windows/native/entry/bin/Debug/junk.dll'), 'ignored')

  const before = hashNativeTree(root)
  assert.match(before.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(before.digest, hashNativeTree(root).digest, '同一棵树必须给出同一个摘要')
  assert.ok(!Object.keys(before.files).some((key) => key.startsWith('entry/bin')), 'bin/ 不得进摘要')

  patchCuaUiLocateBridge(root)
  const after = hashNativeTree(root)
  assert.notEqual(after.digest, before.digest, '打过 native 补丁的 helper 源码摘要必须变')
  assert.equal(after.files['entry/Input.cs'], hashNativeTree(root).files['entry/Input.cs'])
  assert.deepEqual(Object.keys(after.files), Object.keys(before.files).sort(), '补丁只改内容，不新增/删除文件')
  assert.notEqual(after.files['entry/Input.cs'], before.files['entry/Input.cs'])
})

// ── 分发面校验（纯判定，直接执行 .ts） ─────────────────────────────────────

const agent = { id: 'agent-1' }
const agents = new Map([['agent-1', agent]])
// 执行器铸造的 token 是真 symbol；测试里用一个 symbol 代表同一件事。
const token = Symbol('tools/execute')
const liveExecution = (overrides = {}) => ({ callId: 'call-1', token, agent, signal: new AbortController().signal, ...overrides })
/** 登记进活跃表，模拟 tools/execute 包装器进入时的状态。 */
function registered(registry, overrides = {}) {
  const execution = liveExecution(overrides)
  registry.begin(execution)
  return execution
}

test('guard：接受本次调用真实持有、且正在执行的 execution', () => {
  const registry = new LiveDispatchRegistry()
  const execution = registered(registry)
  const checked = checkDispatch(registry, agents, execution)
  assert.equal(checked.callId, 'call-1')
  assert.equal(registry.has(execution), true)
  assert.equal(registry.size, 1)
})

test('guard：调用结束后的 execution 被拒（哪怕字段一模一样、token 也抄走）', () => {
  const registry = new LiveDispatchRegistry()
  const execution = registered(registry)
  checkDispatch(registry, agents, execution)
  registry.end(execution)
  assert.equal(registry.size, 0)
  assert.throws(() => checkDispatch(registry, agents, execution), /not an active call/)
  assert.throws(() => checkDispatch(registry, agents, { ...execution }), /not an active call/, '复制对象不是执行器给的那一个')
})

test('guard：没有执行器铸造的 token 一律拒收（伪造壳）', () => {
  const registry = new LiveDispatchRegistry()
  for (const overrides of [{ token: undefined }, { token: 'tools/execute' }, { token: 1 }]) {
    const execution = registered(registry, overrides)
    assert.throws(() => checkDispatch(registry, agents, execution), /minted by the tool executor/)
  }
})

test('guard：拒收未登记、字段坏掉的壳', () => {
  const registry = new LiveDispatchRegistry()
  const loose = liveExecution()
  assert.throws(() => checkDispatch(registry, agents, undefined), DispatchRejection)
  assert.throws(() => checkDispatch(registry, agents, {}), DispatchRejection)
  assert.throws(() => checkDispatch(registry, agents, { ...loose }), /not an active call/, '没登记过的对象不能过')
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { callId: '' })), /call id/)
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { callId: 7 })), /call id/)
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { agent: { id: 'agent-1' } })), /no longer live/, '同 id 的另一个对象不是那个 agent')
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { agent: { id: 'ghost' } })), /no longer live/)
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { agent: undefined })), /agent-owned/)
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { signal: undefined })), /cancellation signal/)
  assert.throws(() => checkDispatch(registry, agents, registered(registry, { signal: { aborted: false } })), /cancellation signal/, '假 signal 不能过')
})

test('guard：已撤销的调用不能借用分发面', () => {
  const registry = new LiveDispatchRegistry()
  const controller = new AbortController()
  const execution = registered(registry, { signal: controller.signal })
  controller.abort()
  assert.throws(() => checkDispatch(registry, agents, execution), /abort/i)
})

// ── 共享输入队列 ───────────────────────────────────────────────────────────

test('queue：按到达顺序串行，一次只放行一个', async () => {
  const queue = new SystemInputQueue()
  const order = []
  const release1 = await queue.acquire()
  order.push('first')
  const second = queue.acquire().then((release) => {
    order.push('second')
    return release
  })
  assert.equal(queue.busy, true)
  assert.equal(queue.pending, 1)
  release1()
  const release2 = await second
  assert.deepEqual(order, ['first', 'second'])
  release2()
  assert.equal(queue.busy, false)
  assert.equal(queue.pending, 0)
})

test('queue：等待超过上限直接拒绝（有界，不无限堆）', async () => {
  const queue = new SystemInputQueue()
  const release = await queue.acquire()
  const waiting = []
  for (let index = 0; index < MAX_WAITING_INPUTS; index += 1) waiting.push(queue.acquire())
  await assert.rejects(queue.acquire(), (error) => {
    assert.ok(error instanceof InputQueueFullError)
    assert.equal(error.code, 'INPUT_BUSY')
    return true
  })
  release()
  for (const entry of waiting) (await entry)()
})

test('queue：排队中被取消的输入永不执行', async () => {
  const queue = new SystemInputQueue()
  const release = await queue.acquire()
  const controller = new AbortController()
  let ran = false
  const cancelled = queue.acquire(controller.signal).then(() => { ran = true })
  controller.abort()
  await assert.rejects(cancelled, /abort/i)
  assert.equal(queue.pending, 0)
  release()
  assert.equal(ran, false)
  // 槽位没有被取消者占死：下一个仍能拿到。
  const next = await queue.acquire()
  next()
})

test('queue：释放是幂等的，重复释放不会多放行一个', async () => {
  const queue = new SystemInputQueue()
  const release = await queue.acquire()
  release()
  release()
  const a = await queue.acquire()
  let secondRan = false
  const b = queue.acquire().then((releaseB) => { secondRan = true; return releaseB })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(secondRan, false, 'a 还握着槽位')
  a()
  ;(await b)()
})

test('queue：释放时跳过已中止的等待者，把槽位交给下一个真正的等待者', async () => {
  const queue = new SystemInputQueue()
  const release = await queue.acquire()
  const controller = new AbortController()
  const cancelled = queue.acquire(controller.signal)
  let ran = false
  const waiting = queue.acquire().then((releaseNext) => { ran = true; return releaseNext })
  assert.equal(queue.pending, 2)
  controller.abort()
  await assert.rejects(cancelled, /abort/i)
  assert.equal(queue.pending, 1, '中止者必须出队，不能占着位置')
  assert.equal(ran, false, '槽位仍被正在执行的那个握着')
  release()
  const releaseNext = await waiting
  assert.equal(ran, true)
  releaseNext()
  assert.equal(queue.busy, false)
  assert.equal(queue.pending, 0)
})
