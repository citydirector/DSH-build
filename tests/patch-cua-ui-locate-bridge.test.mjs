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
  'packages/experimental/cua/src/guidance.ts',
  'packages/experimental/cua/src/api.ts',
  'packages/experimental/cua-windows/src/index.ts',
  'packages/experimental/cua-windows/src/guidance.ts',
  'packages/experimental/cua-windows/native/entry/Win32.cs',
  'packages/experimental/cua-windows/native/entry/DesktopExecutor.cs',
  'packages/experimental/cua-windows/native/entry/Input.cs',
]

const haveUpstream = existsSync(join(UPSTREAM, TARGETS[0])) && existsSync(join(UPSTREAM, TARGETS.at(-1)))
const missingUpstream = `上游 checkout 不在：${UPSTREAM}（设 UI_LOCATE_UPSTREAM 指向固定上游再跑）`

/** 在仓内的临时目录里做一份镜像，测试结束删掉。 */
function mirror(t) {
  // mkdtemp 要求父目录已存在；`_skadi_temp` 会被清理，所以这里自己补上。
  mkdirSync(join(REPO, '_skadi_temp'), { recursive: true })
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

test('patch：在真实固定上游上把三份注入文件与十八条编辑全部打进去', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  const parts = patchCuaUiLocateBridge(root)
  assert.deepEqual(parts, [
    'packages/experimental/cua/src/index.ts: 4 edits',
    'packages/experimental/cua/src/protocol.ts: 1 edits',
    'packages/experimental/cua/src/types.ts: 2 edits',
    'packages/experimental/cua-windows/src/index.ts: 1 edits',
    'packages/experimental/cua-windows/src/guidance.ts: 1 edits',
    'packages/experimental/cua-windows/native/entry/Win32.cs: 1 edits',
    'packages/experimental/cua-windows/native/entry/DesktopExecutor.cs: 2 edits',
    'packages/experimental/cua-windows/native/entry/Input.cs: 2 edits',
    'packages/experimental/cua/src/guidance.ts: 2 edits',
    'packages/experimental/cua/src/api.ts: 4 edits',
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

// 模型看到的是 guidance 文本（运行时的 `cua_get_api_reference` 就返回它）：
// schema 里有 deliveryMode 但文档不写，模型就不会用——真机验收已经踩过一次。
test('patch：guidance 把 click 的 deliveryMode 与后台拒绝语义写进模型文档', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  const guidance = read(root, 'packages/experimental/cua/src/guidance.ts')
  // 签名：必须作为 click 的 options 出现，而不是另起一行的方法。
  assert.match(guidance, /- click\(target: string \| \[number, number\], options\?: \{[^}]*deliveryMode\?: 'background' \| 'foreground'[^}]*\}\) -> ActionResult/)
  // 三句说明：默认前台 / 只在能力声明时有效且仅限列出的 Win32 类 / 拒绝且绝不回退。
  assert.match(guidance, /Delivery defaults to 'foreground'\./)
  assert.match(guidance, /'background' is only meaningful when getCapabilities\(\) lists 'background' in deliveryModes/)
  assert.match(guidance, /returns BACKGROUND_UNAVAILABLE, and background delivery never falls back to the foreground path\./)
  // 幂等与不重复：每条说明只出现一次。
  assert.equal(guidance.split("Delivery defaults to 'foreground'.").length - 1, 1)
  assert.equal(guidance.split('BACKGROUND_UNAVAILABLE').length - 1, 1)
  assert.equal(guidance.split("deliveryMode?: 'background' | 'foreground'").length - 1, 1)
  // 模板串没有被破坏：整行仍在同一个 COMMON_GUIDANCE 里，且没有引入反引号以外的插值。
  assert.match(guidance, /export const COMMON_GUIDANCE = `Use cua to observe/)
  assert.doesNotMatch(guidance, /\$\{DELIVERY_GUIDANCE\}/, '宿主 guidance 不引用平台常量，说明文字必须是字面量')
})

/**
 * 程序绑定（`cua_run_code` 走的这条）必须把 deliveryMode 原样带进 native 参数。
 * 只改工具层 schema 不够：`api.js` 的 click 构造会丢掉未透传的字段，真机就是这样退回前台的。
 */
function assertApiClickDelivery(text) {
  assert.match(text, /const delivery = options\?\.deliveryMode === undefined \? \{\} : \{ deliveryMode: options\.deliveryMode \}/,
    'click 必须先把 deliveryMode 收成一个可选片段')
  assert.match(text, /\.\.\.relative, \.\.\.delivery, elementId: targetPoint/,
    'element 分支也要 spread delivery')
  assert.match(text, /x, y, mouseButton, clickCount, \.\.\.modifiers, \.\.\.hold, \.\.\.relative, \.\.\.delivery \}\)/,
    'coordinate 分支也要 spread delivery')
}

/** 调用点能写 deliveryMode 的前提：`CuaClickOptions` 从 click 参数里挑出这个键。 */
function assertClickOptionsType(text) {
  assert.match(text, /Pick<CuaParameters<'click'>, 'mouseButton' \| 'clickCount' \| 'modifiers' \| 'holdMs' \| 'deliveryMode'>/,
    'CuaClickOptions 必须接受 deliveryMode，否则调用点类型不通')
}

test('patch：窗口 click 把 deliveryMode 透传到 native（两个分支都 spread）', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  assertApiClickDelivery(read(root, 'packages/experimental/cua/src/api.ts'))
  assertClickOptionsType(read(root, 'packages/experimental/cua/src/types.ts'))
  assert.doesNotMatch(read(root, 'packages/experimental/cua/src/api.ts'), /deliveryMode: undefined/,
    '不能把 undefined 显式塞进参数')
})

// 负控制：同一组断言打在**未打补丁**的源上必须失败——否则这条测试是装饰品。
test('patch：未打补丁的 api.ts / types.ts 过不了 deliveryMode 断言（负控制）', { skip: haveUpstream ? false : missingUpstream }, () => {
  const rawApi = readFileSync(join(UPSTREAM, 'packages/experimental/cua/src/api.ts'), 'utf8')
  const rawTypes = readFileSync(join(UPSTREAM, 'packages/experimental/cua/src/types.ts'), 'utf8')
  assert.throws(() => assertApiClickDelivery(rawApi), /click 必须先把 deliveryMode 收成一个可选片段/)
  assert.throws(() => assertClickOptionsType(rawTypes), /CuaClickOptions 必须接受 deliveryMode/)
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

// ── 生成代码与真实 P/Invoke 签名的一致性（CS0023 的防线） ──────────────────
//
// 补丁生成的是 C#，本机没有 SDK 编译它。所以这里退一步，做**结构性**校验：
// 从真实上游 `Win32.cs` 读每个 `internal static extern` 的返回类型，再对生成代码里
// 每个 `!Win32.X(...)` / `if (Win32.X(...))` 断言 X 真的返回 bool、且带
// `[return: MarshalAs(UnmanagedType.Bool)]`。
// CI 首轮就栽在 `!Win32.GetWindowThreadProcessId(...)` 上——它返回 uint（线程 id）。

/** 解析 `Win32.cs`：方法名 → { returns, declaration }。 */
function win32Signatures(root) {
  const file = join(root, 'packages/experimental/cua-windows/native/entry/Win32.cs')
  const text = readFileSync(file, 'utf8')
  const signatures = new Map()
  const pattern = /internal static extern\s+([A-Za-z_][\w.<>[\]?]*)\s+([A-Za-z_]\w*)\s*\(/g
  for (const match of text.matchAll(pattern)) {
    const start = text.lastIndexOf('\n', match.index) + 1
    const end = text.indexOf('\n', match.index)
    signatures.set(match[2], { returns: match[1], declaration: text.slice(start, end < 0 ? text.length : end) })
  }
  return signatures
}

test('生成的原生代码：对 Win32.X 取反/当布尔用时，X 必须真的返回 bool', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  const signatures = win32Signatures(root)

  assert.ok(signatures.has('GetWindowThreadProcessId'), '上游 Win32.cs 应当已有这个声明')
  assert.equal(signatures.get('GetWindowThreadProcessId').returns, 'uint',
    '它返回线程 id（uint），不是 bool —— 任何 ! 取反都会 CS0023')

  for (const rel of ['packages/experimental/cua-windows/native/entry/Input.cs', 'packages/experimental/cua-windows/native/entry/DesktopExecutor.cs']) {
    const text = read(root, rel)
    // 只认无歧义的取反：`!Win32.X(...)`。像 `if (Win32.SendInput(...) != n)` 这种比较
    // 本身已经是 bool，不属于这一类。
    for (const match of text.matchAll(/!\s*Win32\.(\w+)\s*\(/g)) {
      const guarded = match[1]
      const signature = signatures.get(guarded)
      assert.ok(signature, `${rel} 用了不存在的 Win32.${guarded}（拼错或没声明）`)
      assert.equal(signature.returns, 'bool', `${rel} 对 Win32.${guarded} 取反，但它返回 ${signature.returns} → 会 CS0023`)
      assert.match(signature.declaration, /MarshalAs\(UnmanagedType\.Bool\)/,
        `Win32.${guarded} 返回 bool 却缺 [return: MarshalAs(UnmanagedType.Bool)]，默认封送会读错返回值`)
    }
  }
})

test('生成的 Input.cs：归属校验只看 out 的 pid，且不再对 GetWindowThreadProcessId 取反', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  const input = read(root, 'packages/experimental/cua-windows/native/entry/Input.cs')

  assert.doesNotMatch(input, /!\s*Win32\.GetWindowThreadProcessId/, 'CS0023 的来源：uint 不能取反')
  assert.match(input, /Win32\.GetWindowThreadProcessId\(hit, out var hitProcess\);/, '必须先调用再单独判 pid')
  assert.match(input, /if \(hitProcess != \(uint\)window\.ProcessId\)/, '归属校验保留：pid 不同就 BACKGROUND_UNAVAILABLE')
  // 语义没缩水：这条分支仍然抛 BACKGROUND_UNAVAILABLE，而不是静默继续。
  assert.match(input, /hitProcess != \(uint\)window\.ProcessId\)\s*\n\s*throw new NativeFailure\("BACKGROUND_UNAVAILABLE"/)
})
test('注入的 TS 源码：`exactOptionalPropertyTypes` 下不把 undefined 显式塞进可选属性', () => {
  // 上游 `tsconfig.base.json` 开了 exactOptionalPropertyTypes，`{ signal }` 这种写法
  // 在 signal 可能是 undefined 时会 TS2375（CI 三个产物 job 的真实红因）。
  const queue = readFileSync(new URL('../portable/cua-bridge-files/cua/system-input-queue.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(queue, /\{\s*resolve,\s*reject,\s*signal\s*\}/,
    'Waiter 的可选 signal 不能直接赋值：TS2375')
  assert.match(queue, /\.\.\.\(signal \? \{ signal \} : \{\}\)/,
    'signal 只能条件展开，这样「没有 signal」就是缺字段而不是显式 undefined')
  // 也不要用显式 undefined 绕过可选属性。

  assert.doesNotMatch(queue, /signal:\s*undefined/, '不要用显式 undefined 绕过可选属性')
})
/** 本地 zod 探针目录（`_skadi_temp/zodprobe`，含 zod v4）；不存在就跳过行为测试，并说明原因。 */
const ZOD_PROBE = join(REPO, '_skadi_temp', 'zodprobe')
const haveZod = existsSync(join(ZOD_PROBE, 'node_modules', 'zod', 'package.json'))
const missingZod = '本地没有 zod：在 _skadi_temp/zodprobe 里 npm install zod@4 后再跑（CI 无依赖，跳过并说明）'

/** capabilities 的原生骨架：provider 只额外补 deliveryModes，其余字段 native 都会给。 */
const CAPABILITIES_BASE = {
  platform: 'windows',
  permissions: { accessibility: true, screenRecording: true },
  appLevelAccessibility: false,
  keyboard: ['window'],
  sessionLocked: false,
  methods: ['click', 'screenshot'],
  coordinateSpace: 'screenshot-pixels',
  browser: false,
}

test('patch：deliveryModes 从原始响应读出并挂回能力对象，公共类型不动', { skip: haveUpstream ? false : missingUpstream }, (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  const api = read(root, 'packages/experimental/cua/src/api.ts')

  // 读出来的值必须校验过：只认枚举里的字符串，别把 provider 顺手塞的东西带进来。
  assert.match(api, /function readDeliveryModes\(value: JsonValue\): \('background' \| 'foreground'\)\[\] \| undefined \{/,
    'api.ts 要有 readDeliveryModes')
  assert.match(api, /mode === 'background' \|\| mode === 'foreground'/, '只收枚举内的值')
  assert.match(api, /return modes\.length === 0 \? undefined : modes/, '空数组等于没声明')
  assert.match(api, /capabilities = declared === undefined \? parsed : Object\.assign\(parsed, \{ deliveryModes: declared \}\)/,
    '声明了才挂上去')

  // schema 里绝不能有 deliveryModes：zod 的 .optional() 推断出 `| undefined`，CuaCapabilities 就不满足 JsonValue（真 CI 的 TS2322）。
  assert.doesNotMatch(read(root, 'packages/experimental/cua/src/protocol.ts'), /deliveryModes/,
    'CapabilitiesResult 不能声明这个字段')
  // 反向也要守住：不能靠 passthrough 绕过（zod v4 的 passthrough 会给输出类型加 unknown 索引签名，同样撞 JsonValue）。
  assert.doesNotMatch(read(root, 'packages/experimental/cua/src/protocol.ts'), /\.passthrough\(\)/,
    'passthrough 会让输出类型多出 unknown 索引签名')

  const index = read(root, 'packages/experimental/cua/src/index.ts')
  assert.match(index, /\.\.\.\(capabilities\.deliveryModes === undefined \? \{\} : \{ deliveryModes: \[\.\.\.capabilities\.deliveryModes\] \}\),/,
    'provider 声明了才合并进 getCapabilities 响应')
  assert.doesNotMatch(index, /\?\? \['foreground'\]/, '不能用缺省值把「未声明」伪装成支持')
})

// 负控制：同一组结构断言打在未打补丁的真实上游上必须失败。
test('patch：未打补丁的 api.ts / index.ts 过不了 deliveryModes 断言（负控制）', { skip: haveUpstream ? false : missingUpstream }, () => {
  const rawApi = readFileSync(join(UPSTREAM, 'packages/experimental/cua/src/api.ts'), 'utf8')
  const rawIndex = readFileSync(join(UPSTREAM, 'packages/experimental/cua/src/index.ts'), 'utf8')
  assert.doesNotMatch(rawApi, /readDeliveryModes/, '上游 api.ts 本来不读这个键')
  assert.doesNotMatch(rawIndex, /deliveryModes/, '上游 callNative 的 getCapabilities 合并本来不碰它')
})

/** 把打过补丁的 protocol.ts / api.ts 拷进本地 zod 探针目录并 import 回来（目录里已有 zod 与 type:module）。 */
async function loadCuaApiFrom(root, label) {
  const name = `api-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const protocolTarget = join(ZOD_PROBE, `${name}-protocol.ts`)
  const apiTarget = join(ZOD_PROBE, `${name}-api.ts`)
  writeFileSync(protocolTarget, readFileSync(join(root, 'packages/experimental/cua/src/protocol.ts'), 'utf8'))
  // api.ts 用相对路径 import './protocol.ts'，两条都拷进同一目录后名字必须对得上。
  writeFileSync(apiTarget, readFileSync(join(root, 'packages/experimental/cua/src/api.ts'), 'utf8')
    .replace("from './protocol.ts'", `from './${name}-protocol.ts'`))
  try {
    const mod = await import(new URL(`./${name}-api.ts`, new URL(`file:///${ZOD_PROBE.replaceAll('\\', '/')}/`)).href)
    return mod.createCuaApi
  } finally {
    rmSync(protocolTarget, { force: true })
    rmSync(apiTarget, { force: true })
  }
}

/** 一个只回答 getCapabilities 的假分发面；provider 合并后的响应长这样。 */
const dispatchReturning = (payload) => async () => payload

// 行为测试：真的跑补丁产物的 api.ts，不是只读文本。
test('behavior：声明了就出现在 getCapabilities() 里，没声明就没有这个键', { skip: haveZod ? false : missingZod }, async (t) => {
  const root = mirror(t)
  patchCuaUiLocateBridge(root)
  const createCuaApi = await loadCuaApiFrom(root, 'patched')

  const declared = await createCuaApi(dispatchReturning({ ...CAPABILITIES_BASE, deliveryModes: ['foreground', 'background'] })).getCapabilities()
  assert.deepEqual(declared.deliveryModes, ['foreground', 'background'])

  const undeclared = await createCuaApi(dispatchReturning(CAPABILITIES_BASE)).getCapabilities()
  assert.equal('deliveryModes' in undeclared, false, '没声明就该没有这个键，而不是 [] 或 undefined')

  // 脏数据不进门：非枚举值被过滤掉，全被过滤就等于没声明。
  const dirty = await createCuaApi(dispatchReturning({ ...CAPABILITIES_BASE, deliveryModes: ['background', 'teleport'] })).getCapabilities()
  assert.deepEqual(dirty.deliveryModes, ['background'])
  const junk = await createCuaApi(dispatchReturning({ ...CAPABILITIES_BASE, deliveryModes: 'yes' })).getCapabilities()
  assert.equal('deliveryModes' in junk, false, '不是数组就当没声明')

  // 负控制：未打补丁的 api.ts 即使拿到同样响应，也读不到这个键。
  const rawCreateCuaApi = await (async () => {
    const name = `raw-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const protocolTarget = join(ZOD_PROBE, `${name}-protocol.ts`)
    const apiTarget = join(ZOD_PROBE, `${name}-api.ts`)
    writeFileSync(protocolTarget, readFileSync(join(UPSTREAM, 'packages/experimental/cua/src/protocol.ts'), 'utf8'))
    writeFileSync(apiTarget, readFileSync(join(UPSTREAM, 'packages/experimental/cua/src/api.ts'), 'utf8')
      .replace("from './protocol.ts'", `from './${name}-protocol.ts'`))
    try {
      return (await import(new URL(`./${name}-api.ts`, new URL(`file:///${ZOD_PROBE.replaceAll('\\', '/')}/`)).href)).createCuaApi
    } finally {
      rmSync(protocolTarget, { force: true })
      rmSync(apiTarget, { force: true })
    }
  })()
  const stripped = await rawCreateCuaApi(dispatchReturning({ ...CAPABILITIES_BASE, deliveryModes: ['foreground', 'background'] })).getCapabilities()
  assert.equal('deliveryModes' in stripped, false, '未打补丁的 api.ts 会把 provider 声明的能力丢掉')
})