// portable/lib/profile-compat.mjs 的单元测试（node:test，零依赖）。
// 运行: node tests/profile-compat.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, migratePatchText, migrateProfile } from '../portable/lib/profile-compat.mjs'

const SUBAGENT = '@deepseek-ai/dsh-tool-subagent'
const PI_AI = '@deepseek-ai/dsh-llm-pi-ai'
const PRESENTATION = '@deepseek-ai/dsh-agent-tool-presentation'
const EXECUTOR_PTC = '@deepseek-ai/dsh-tool-executor-ptc'
const LIST_AGENTS = '@deepseek-ai/dsh-tool-subagent-control/list-agents'

/** 假的运行时：resolvable 由集合决定，sourceOf 由 map 决定。 */
function fakeRuntime({ resolvable = [], sources = {} } = {}) {
  const set = new Set(resolvable)
  return {
    resolvable: specifier => set.has(specifier),
    sourceOf: name => sources[name],
  }
}

/** 稳定版运行时：列表里那条子路径在、executor-ptc 不在、presentation 还是真实实现。 */
function stableRuntime() {
  return fakeRuntime({
    resolvable: [LIST_AGENTS, PRESENTATION],
    sources: {
      [SUBAGENT]: 'const Config = z.object({ modelSelection: z.boolean() })',
      [PI_AI]: 'const modelFields = { name, contextWindow, maxTokens }',
      [PRESENTATION]: 'function apply(ctx, config) { ctx.tools.presentAs(config.mode) }',
    },
  })
}

/** dev 运行时：子路径没了、executor-ptc 在、presentation 是弃用转发壳、pi-ai 不认图片预算。 */
function devRuntime() {
  return fakeRuntime({
    resolvable: [EXECUTOR_PTC, PRESENTATION],
    sources: {
      [SUBAGENT]: 'const Config = z.object({ modelSelection: z.boolean(), modelDiscovery: z.boolean() })',
      [PI_AI]: 'const modelFields = { name, contextWindow, maxTokens, input, reasoningEfforts, compat }',
      [PRESENTATION]: '/** @deprecated mount the executor directly */ function apply(ctx, config) { ctx.plugin(config.mode === "native" ? Native : Ptc) }',
    },
  })
}

const DELEGATION_BLOCK = [
  '- id: tool-subagent-control',
  "  name: '@deepseek-ai/dsh-tool-subagent-control'",
  '',
  '- id: tool-subagent-list-agents',
  "  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
  '',
  '- id: tool-subagent',
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  '  config:',
  '    provider: spawn',
  '    modelSelectionSettings: true',
  '',
].join('\n')

test('dev 运行时没有 /list-agents 子路径：整块被删，主入口行保留', () => {
  const result = migratePatchText(DELEGATION_BLOCK, devRuntime())
  assert.equal(result.text.includes('tool-subagent-list-agents'), false)
  assert.equal(result.text.includes(LIST_AGENTS), false)
  // 主入口与 tool-subagent 行必须还在（list_agents 功能由主入口自己注册）
  assert.equal(result.text.includes('- id: tool-subagent-control'), true)
  assert.equal(result.text.includes('- id: tool-subagent'), true)
  assert.equal(result.changes.length, 2)
  assert.deepEqual(result.changes.map(change => change.kind), ['list-agents', 'model-selection'])
  assert.deepEqual(result.warnings, [])
})

test('stable 运行时有 /list-agents：那一行一个字节都不动', () => {
  const result = migratePatchText(DELEGATION_BLOCK, stableRuntime())
  assert.equal(result.text.includes(LIST_AGENTS), true)
  assert.equal(result.changes.some(change => change.kind === 'list-agents'), false)
})

test('有子路径但配置里没这行：补回来（stable 只能靠这条子路径提供 list_agents）', () => {
  // 早先这里只报警告不改 —— 那是把迁移当成一次性的单向升级。现在两个方向都要走得通：
  // 从 dev 回退到 stable 时，主入口不再注册 list_agents，缺了这一行工具直接消失。
  const text = ['- id: tool-subagent-control', "  name: '@deepseek-ai/dsh-tool-subagent-control'", ''].join('\n')
  const result = migratePatchText(text, stableRuntime())
  assert.equal(result.text.includes('- id: tool-subagent-list-agents'), true)
  assert.equal(result.text.includes(LIST_AGENTS), true)
  assert.deepEqual(result.warnings, [])
})

test('modelSelectionSettings 保留原行并补出 modelSelection / modelDiscovery', () => {
  const result = migratePatchText(DELEGATION_BLOCK, stableRuntime())
  assert.equal(result.text.includes('    modelSelectionSettings: true'), true)
  assert.equal(result.text.includes('    modelSelection: true'), true)
  assert.equal(result.text.includes('    modelDiscovery: true'), true)
})

test('三个键沿用原值，不是硬编码 true', () => {
  const text = ['- id: tool-subagent', '  config:', '    modelSelectionSettings: false', ''].join('\n')
  const result = migratePatchText(text, stableRuntime())
  assert.equal(result.text.includes('    modelSelection: false'), true)
  assert.equal(result.text.includes('    modelDiscovery: false'), true)
})

test('死键只在源码确实没有该词时删', () => {
  const text = [
    '- id: tool-subagent',
    '  config:',
    '    backgroundMode: continuable',
    '    enableRunInBackground: false',
    '',
  ].join('\n')
  const result = migratePatchText(text, stableRuntime())
  assert.equal(result.text.includes('backgroundMode'), false)
  assert.equal(result.text.includes('enableRunInBackground'), false)
  assert.equal(result.changes.filter(change => change.kind === 'dead-key').length, 2)
})

test('源码里仍有该键时绝不删', () => {
  const text = ['- id: tool-subagent', '  config:', '    backgroundMode: continuable', ''].join('\n')
  const runtime = fakeRuntime({ resolvable: [LIST_AGENTS], sources: { [SUBAGENT]: 'backgroundMode: z.enum([...])' } })
  const result = migratePatchText(text, runtime)
  assert.equal(result.text.includes('backgroundMode: continuable'), true)
  assert.deepEqual(result.changes, [])
})

test('读不到源码 = 判断不了，保留并回报', () => {
  const text = ['- id: tool-subagent', '  config:', '    backgroundMode: continuable', ''].join('\n')
  // resolvable 里不放 list-agents：这里只想验「源码读不到 = 不动」这一条
  const result = migratePatchText(text, fakeRuntime({ resolvable: [] }))
  assert.equal(result.text, text)
  assert.deepEqual(result.warnings.map(warning => warning.kind), ['subagent'])
})

test('图片预算键只在 llm-pi-ai 段里删，别的段（llm-deepseek）不碰', () => {
  const text = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ollama:',
    '        models:',
    '          - imagePixelBudget: 640000',
    '            imageMaxBytes: 1048576',
    '            name: qwen',
    '',
    '- id: llm-deepseek',
    '  config:',
    '    models:',
    '      - imagePixelBudget: 640000',
    '        name: deepseek',
    '',
  ].join('\n')
  const result = migratePatchText(text, devRuntime())
  const lines = result.text.split('\n')
  const piAi = lines.slice(0, lines.indexOf('- id: llm-deepseek')).join('\n')
  const deepseek = lines.slice(lines.indexOf('- id: llm-deepseek')).join('\n')
  assert.equal(piAi.includes('imagePixelBudget'), false)
  assert.equal(piAi.includes('imageMaxBytes'), false)
  assert.equal(piAi.includes('name: qwen'), true)
  assert.equal(deepseek.includes('imagePixelBudget: 640000'), true)
  // 被删的两行是列表元素的首键，"- " 标记必须转交给下一个兄弟键 ——
  // 否则 models 会从数组塌成映射，上游报 expected array but got [object Object]
  assert.equal(piAi.includes('          - name: qwen'), true)
})


test('删掉元素首键时把 "- " 标记转交给下一个兄弟键', () => {
  const text = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ollama:',
    '        models:',
    '          - imagePixelBudget: 640000',
    '            id: deepseek-v4.1-flash:1017',
    '            name: Ollama/Deepseek-V4.1-flash',
    '',
  ].join('\n')
  const result = migratePatchText(text, devRuntime())
  assert.equal(result.text.includes('- id: deepseek-v4.1-flash:1017'), true)
  assert.equal(result.text.includes('imagePixelBudget'), false)
})

test('元素只剩一个键被删空时不留下孤零零的 "- "', () => {
  const text = [
    '- id: llm-pi-ai',
    '  config:',
    '    models:',
    '      - imagePixelBudget: 640000',
    '',
    '- id: after',
    '',
  ].join('\n')
  const result = migratePatchText(text, devRuntime())
  assert.equal(result.text.includes('imagePixelBudget'), false)
  assert.equal(/^[ \t]*-[ \t]*$/mu.test(result.text), false)
})

test('已经写坏的配置（models 下整块没有标记）会被补回来', () => {
  const broken = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ollama:',
    '        models:',
    '          id: deepseek-v4.1-flash:1017',
    '          name: Ollama/Deepseek-V4.1-flash',
    '          input:',
    '            - text',
    '            - image',
    '      deepinfra:',
    '        models:',
    '          - id: deepinfra/one',
    '',
  ].join('\n')
  const result = migratePatchText(broken, devRuntime())
  assert.equal(result.text.includes('        - id: deepseek-v4.1-flash:1017'), true)
  assert.equal(result.text.includes('          - id: deepinfra/one'), true)
  assert.equal(result.changes.filter(change => change.kind === 'model-list').length, 1)
})

test('自愈也是幂等的', () => {
  const broken = [
    '- id: llm-pi-ai',
    '  config:',
    '    models:',
    '      id: only',
    '',
  ].join('\n')
  const once = migratePatchText(broken, devRuntime()).text
  assert.equal(migratePatchText(once, devRuntime()).text, once)
})

test('stable 运行时（presentation 未弃用、executor-ptc 解析不到）不换 tool-presentation', () => {
  const text = [
    '- id: tool-presentation',
    "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '  config:',
    '    mode: ptc',
    '',
  ].join('\n')
  const result = migratePatchText(text, stableRuntime())
  assert.equal(result.text, text)
})

test('dev 运行时把 tool-presentation(mode: ptc) 换成 tool-executor-ptc', () => {
  const text = [
    '- id: tool-presentation',
    "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '  config:',
    '    mode: ptc',
    '',
  ].join('\n')
  const result = migratePatchText(text, devRuntime())
  assert.equal(result.text.includes('- id: tool-executor-ptc'), true)
  assert.equal(result.text.includes("name: '" + EXECUTOR_PTC + "'"), true)
  assert.equal(result.text.includes('tool-presentation'), false)
  assert.equal(result.text.includes('mode: ptc'), false)
})

test('mode 不是 ptc 时不换（native 那条路仍由 presentation 转发）', () => {
  const text = [
    '- id: tool-presentation',
    "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '  config:',
    '    mode: native',
    '',
  ].join('\n')
  const result = migratePatchText(text, devRuntime())
  assert.equal(result.text, text)
})

test('迁移是幂等的：第二次跑一个字节都不改', () => {
  const first = migratePatchText(DELEGATION_BLOCK, devRuntime())
  const second = migratePatchText(first.text, devRuntime())
  assert.equal(second.text, first.text)
  assert.deepEqual(second.changes, [])
})

test('CRLF 文件迁移后仍是 CRLF', () => {
  const text = DELEGATION_BLOCK.replaceAll('\n', '\r\n')
  const result = migratePatchText(text, devRuntime())
  assert.equal(result.text.includes('\r\n'), true)
  assert.equal(/[^\r]\n/u.test(result.text), false)
})

test('migrateProfile：写盘、返回变更、二次调用不再写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-compat-'))
  writeFileSync(join(dir, 'cordis.patch.yml'), DELEGATION_BLOCK)
  const runtime = devRuntime()
  const first = migrateProfile(dir, runtime)
  assert.equal(first.changed, true)
  assert.equal(first.file, join(dir, 'cordis.patch.yml'))
  const written = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.equal(written, migratePatchText(DELEGATION_BLOCK, runtime).text)
  assert.equal(written.includes(LIST_AGENTS), false)
  const second = migrateProfile(dir, runtime)
  assert.equal(second.changed, false)
  assert.deepEqual(second.changes, [])
})

test('migrateProfile：目录里没有 cordis.patch.yml 时安静返回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-compat-empty-'))
  mkdirSync(join(dir, 'nothing'))
  const result = migrateProfile(dir, devRuntime())
  assert.equal(result.changed, false)
  assert.deepEqual(result.changes, [])
  assert.deepEqual(result.warnings, [])
})

test('createRuntime：相对运行时目录也能构造（update.exe 与 CI 冒烟传的是相对路径）', () => {
  // createRequire 只吃绝对路径或 file URL；上一版直接把参数塞进去，CI 冒烟因此报
  // "The argument 'filename' must be ... an absolute path string"。
  const runtime = createRuntime('some\\relative\\runtime')
  assert.equal(typeof runtime.resolvable, 'function')
  assert.equal(runtime.resolvable('@deepseek-ai/dsh-nope-pkg'), false)
})

test('createRuntime：解析不到的 specifier 返回 false，读不出的包返回 undefined', () => {
  // 拿测试文件自己的目录当运行时根（有 package.json 的父级不一定在，所以只验保守行为）
  const runtime = createRuntime(process.cwd())
  assert.equal(runtime.resolvable('@deepseek-ai/dsh-tool-subagent-control/list-agents-nope'), false)
  assert.equal(runtime.sourceOf('@deepseek-ai/dsh-nope-pkg'), undefined)
})

/** 从 dev 口径回退到 stable 时必须还原的那份配置。 */
const DEV_SHAPED = [
  '- id: tool-subagent-control',
  "  name: '@deepseek-ai/dsh-tool-subagent-control'",
  '',
  '- id: tool-subagent',
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  '  config:',
  '    provider: spawn',
  '    modelSelectionSettings: true',
  '    modelSelection: true',
  '    modelDiscovery: true',
  '',
].join('\n')

test('回到 stable：运行时又有 /list-agents 子路径时把整块补回来', () => {
  // 从 dev 回退到 stable 必须能把这条加回来 —— stable 的主入口不注册 list_agents，
  // 子路径是它唯一的提供者，缺了工具就消失（旧 provider 回退后遇到的一半问题就是它）。
  const result = migratePatchText(DEV_SHAPED, stableRuntime())
  assert.equal(result.text.includes('tool-subagent-list-agents'), true)
  assert.equal(result.text.includes(LIST_AGENTS), true)
  // 插在主入口块之后，且自己独占一块（前后都有空行）
  const lines = result.text.split('\n')
  const anchor = lines.findIndex(line => line.includes('- id: tool-subagent-control'))
  // 主入口的 name 行、分隔空行，然后才是新块；新块自己还带一个尾空行。
  assert.equal(lines[anchor + 3], '- id: tool-subagent-list-agents')
  assert.equal(lines[anchor + 4], "  name: '" + LIST_AGENTS + "'")
  assert.equal(lines[anchor + 5], '')
})

test('回到 stable：没有 executor-ptc 时把它换回 presentation', () => {
  const source = [
    '- id: tool-executor-ptc',
    "  name: '@deepseek-ai/dsh-tool-executor-ptc'",
    '',
  ].join('\n')
  const result = migratePatchText(source, stableRuntime())
  assert.equal(result.text.includes('tool-executor-ptc'), false)
  assert.match(result.text, /- id: tool-presentation/u)
  assert.match(result.text, /mode: ptc/u)
})

test('回到 stable：配置里本来就有 presentation 时只删 executor 块，不重复挂', () => {
  // 同一 scope 挂两个 tool executor，上游会报 "Only one tool executor may be registered
  // in each scope"。所以已有 presentation 时只能删，不能再补一份。
  const source = [
    '- id: tool-presentation',
    "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '  config:',
    '    mode: ptc',
    '',
    '- id: tool-executor-ptc',
    "  name: '@deepseek-ai/dsh-tool-executor-ptc'",
    '',
  ].join('\n')
  const result = migratePatchText(source, stableRuntime())
  assert.equal(result.text.includes('tool-executor-ptc'), false)
  assert.equal(result.text.match(/- id: tool-presentation/gu).length, 1)
})

test('反向迁移也是幂等的', () => {
  const once = migratePatchText(DEV_SHAPED, stableRuntime()).text
  assert.equal(migratePatchText(once, stableRuntime()).text, once)
})

test('dev 运行时下 presentation 换成 executor-ptc', () => {
  const source = [
    '- id: tool-presentation',
    "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '  config:',
    '    mode: ptc',
    '',
  ].join('\n')
  const result = migratePatchText(source, devRuntime())
  assert.equal(result.text.includes('tool-presentation'), false)
  assert.match(result.text, /- id: tool-executor-ptc/u)
})

// ── Computer Use：旧 provider 只删不写，bundle 走 profile 的 dsh.profile.bundles ──
//
// 为什么不再写 "- id: cua-bundle" 插件行：那行的 name 指向 @deepseek-ai/dsh-cua-bundle，
// 而该包的 lib/index.js 全文只有一个 "export {}" —— 它是 bundle 载体，真正的插件行在它自己的
// cordis.patch.yml 里。把它当插件写时，cordis-plugin-loader 的 _init() 先 unwrapExports 出
// 一个空命名空间对象，registry.resolve() 既不是函数也没有 apply，抛
//   invalid plugin, expect function or object with an "apply" method, received object
// 而 _init() 只 catch import 失败，这条抛错冒泡到 Entry.update()，整次 include apply 失败。
// 用户看到的是「装 / 更新任何插件都报 apply 失败」，pnpm 那一步却是成功的。
// 正确入口只有 profile package.json 的 dsh.profile.bundles —— 见 migrateProfile 的测试。
//
// 两条证据（旧 provider 行的真实形状）：
//   native —— 真实发行的 desktop profile（data/profiles/desktop/cordis.patch.yml 的 "- insert:"
//             段，缩进 4）写着 "- id: computer-use-cua-native" + 旧 native 包名。注意 id 不是包名
//             尾段，照包名猜会永远匹配不上真实配置。
//   mcp    —— 上游 39163dd 的 snapshots/session/computer-use-cua-driver-mcp/cordis.yml:32-33。
// 旧配置也可能是用户自己写的，猜错等于擅自换了工具面，所以带自定义 config / 显式停用 / 注释 /
// 未知键的一律不碰，只留 warning。

const LEGACY_NATIVE = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
const LEGACY_MCP = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
const CUA_BUNDLE_NAME = '@deepseek-ai/dsh-cua-bundle'
const MCP_ROW = '- id: computer-use-cua-driver-mcp\n  name: \'' + LEGACY_MCP + '\''
const NATIVE_ROW = '- id: computer-use-cua-native\n  name: \'' + LEGACY_NATIVE + '\''
const REGISTRY_ROW = '- id: computer-use\n  name: \'@deepseek-ai/dsh-computer-use\''
const CARRIER_ROW = '- id: cua-bundle\n  name: \'' + CUA_BUNDLE_NAME + '\''

/** 只认这些迁移，别的段落一律原样 —— 所以运行时给一个什么都不认的假实现。 */
const plainRuntime = () => fakeRuntime({})

const warningText = (result) => result.warnings.map(warning => warning.detail).join('\n')
const cuaChanges = (result) => result.changes.filter(change => change.kind === 'computer-use')
/** 配置文本里还有没有把 bundle 当插件写的行。 */
const carrierRows = (text) => (text.match(/- id: cua-bundle/gu) ?? []).length

/** 一个最小 profile 目录：cordis.patch.yml + 可选 package.json。 */
function tempProfile({ patch, manifest }) {
  const dir = mkdtempSync(join(tmpdir(), 'profile-cua-'))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  if (manifest !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return dir
}

test('旧 mcp provider 行被删掉，并要求 profile 用 bundles 引入 bundle', () => {
  const source = [
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '',
    MCP_ROW,
    '',
    '- id: attachment-local',
    "  name: '@deepseek-ai/dsh-attachment-local'",
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text.includes(LEGACY_MCP), false)
  // 关键：不再写任何插件行 —— 写进去就是毒行
  assert.equal(carrierRows(result.text), 0)
  assert.equal(result.text.includes(CUA_BUNDLE_NAME), false)
  assert.equal(result.needsBundle, true)
  // 上下文没被吃掉：前后两个块还在
  assert.match(result.text, /- id: agent-default-model/u)
  assert.match(result.text, /- id: attachment-local/u)
  assert.equal(cuaChanges(result).length, 1)
})

test('真实发行形状：注册表行与 native provider 一起消失，insert 头与注释原样', () => {
  const source = [
    '# 约束：一个组合只允许注册**一个** computer-use 提供方。',
    '- insert:',
    '    - id: computer-use',
    "      name: '@deepseek-ai/dsh-computer-use'",
    '    - id: computer-use-cua-native',
    "      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'",
    '',
    '- insert:',
    '    - id: browser-use',
    "      name: '@deepseek-ai/dsh-browser-use'",
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(carrierRows(result.text), 0)
  assert.equal(result.text.includes('computer-use-cua-native'), false)
  assert.equal(result.text.includes('@deepseek-ai/dsh-computer-use\''), false)
  assert.equal(result.text.includes('@deepseek-ai/dsh-experimental-computer-use'), false)
  assert.equal(result.needsBundle, true)
  assert.equal((result.text.match(/^- insert:/gmu) ?? []).length, 2)
  assert.match(result.text, /^# 约束：一个组合只允许注册/u)
  assert.match(result.text, /- id: browser-use/u)
  assert.equal(cuaChanges(result).length, 2)
  assert.match(cuaChanges(result).map(change => change.detail).join('\n'), /旧注册表行 computer-use/u)
})

test('真实发行形状迁移后再跑一次：原文一字不变、零 change、不再要 bundles', () => {
  const source = [
    '- insert:',
    '    - id: computer-use',
    "      name: '@deepseek-ai/dsh-computer-use'",
    '    - id: computer-use-cua-native',
    "      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'",
    '',
  ].join('\n')
  const once = migratePatchText(source, plainRuntime())
  const twice = migratePatchText(once.text, plainRuntime())
  assert.equal(twice.text, once.text)
  assert.equal(cuaChanges(twice).length, 0)
  assert.equal(twice.needsBundle, false)
})

test('配置里已经有把 bundle 当插件写的行 → 删除，并声明需要 bundles', () => {
  const source = [
    '- insert:',
    '    ' + CARRIER_ROW.replace('\n', '\n    '),
    '',
    '- insert:',
    '    - id: browser-use',
    "      name: '@deepseek-ai/dsh-browser-use'",
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(carrierRows(result.text), 0)
  assert.equal(result.text.includes(CUA_BUNDLE_NAME), false)
  assert.equal(result.needsBundle, true)
  assert.match(result.text, /- id: browser-use/u)
  assert.match(cuaChanges(result).map(change => change.detail).join('\n'), /当插件写的行/u)
})

test('毒行被显式停用：删掉，但不把 bundle 加进 bundles（用户明确不要）', () => {
  const source = [
    '- id: cua-bundle',
    "  name: '@deepseek-ai/dsh-cua-bundle'",
    '  disabled: true',
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text.includes('cua-bundle'), false)
  assert.equal(result.needsBundle, false)
})

test('毒行块里的注释原样留下（那是用户的心智记录）', () => {
  const source = [
    '- id: cua-bundle',
    '  # 我手动加过 cua，别删这条备注',
    "  name: '@deepseek-ai/dsh-cua-bundle'",
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text.includes('我手动加过 cua'), true)
  assert.equal(result.text.includes(CUA_BUNDLE_NAME), false)
})

test('旧行被显式停用时整份不动 —— 默认启用不能把用户的关闭动作翻回来', () => {
  const source = [
    '- id: computer-use-cua-driver-mcp',
    "  name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'",
    '  disabled: true',
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text, source)
  assert.equal(result.needsBundle, false)
  assert.match(warningText(result), /显式停用/u)
})

test('旧行带自定义 config 时不动（无法证明等价）', () => {
  const source = [
    '- id: computer-use-cua-driver-mcp',
    "  name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'",
    '  config:',
    '    mode: attach',
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text, source)
  assert.equal(result.needsBundle, false)
  assert.match(warningText(result), /自定义 config/u)
})

test('旧行带未知键（priority 等）时不动', () => {
  const source = [
    '- id: computer-use-cua-driver-mcp',
    "  name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'",
    '  priority: 50',
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text, source)
  assert.equal(result.needsBundle, false)
  assert.match(warningText(result), /含非发行键/u)
})

test('native 的 id 按包名尾段猜（不是发行 id）→ 只诊断，不改', () => {
  const source = [
    '- insert:',
    '    - id: computer-use-cua-driver-native',
    '      ' + NATIVE_ROW.replace('\n', '\n      '),
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text, source)
  assert.equal(result.needsBundle, false)
  assert.match(warningText(result), /id 不是发行 id/u)
})

test('旧注册表行在别的段里 → 保留原文并告警，不猜着删', () => {
  const source = [
    '- insert:',
    '    ' + REGISTRY_ROW.replace('\n', '\n    '),
    '',
    '- insert:',
    '    ' + NATIVE_ROW.replace('\n', '\n    '),
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text, source)
  assert.equal(result.needsBundle, false)
  assert.match(warningText(result), /旧注册表行 computer-use/u)
})

test('同一个 mcp 行被重复挂了两次 → 两行都删，不留插件行', () => {
  const source = [MCP_ROW, '', MCP_ROW, ''].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text.includes(LEGACY_MCP), false)
  assert.equal(carrierRows(result.text), 0)
  assert.equal(result.needsBundle, true)
  assert.equal(cuaChanges(result).length, 2)
})

test('旧行分散在两个 insert 段里 → 两行都删（不再写插件行，也就没有同 id 冲突）', () => {
  const source = [
    '- insert:',
    '    ' + NATIVE_ROW.replace('\n', '\n    '),
    '',
    '- insert:',
    '    ' + MCP_ROW.replace('\n', '\n    '),
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text.includes(LEGACY_NATIVE), false)
  assert.equal(result.text.includes(LEGACY_MCP), false)
  assert.equal(carrierRows(result.text), 0)
  assert.equal(result.needsBundle, true)
})

test('跟 Computer Use 无关的配置一个字都不动', () => {
  const source = [
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '',
    '- id: attachment-local',
    "  name: '@deepseek-ai/dsh-attachment-local'",
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text, source)
  assert.equal(result.changes.length, 0)
  assert.equal(result.needsBundle, false)
})

test('配置里已有 id: cua-bundle（name 不是 bundle）→ 旧行照样删，bundle 仍走 bundles 清单', () => {
  const source = [
    '- id: cua-bundle',
    "  name: 'some-other-plugin'",
    '',
    MCP_ROW,
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  // some-other-plugin 不是 bundle 载体，5a 不碰它；旧 provider 行被删
  assert.equal(result.text.includes(LEGACY_MCP), false)
  assert.equal(result.text.match(/- id: cua-bundle/gu).length, 1)
  assert.equal(result.needsBundle, true)
})

test('migrateProfile：删掉旧链后把 bundle 写进 package.json 的 dsh.profile.bundles', () => {
  const dir = tempProfile({
    patch: [MCP_ROW, ''].join('\n'),
    manifest: { name: 'p', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } } },
  })
  const result = migrateProfile(dir, plainRuntime())
  assert.equal(result.changed, true)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', CUA_BUNDLE_NAME])
  assert.equal(manifest.dsh.profile.patchReload, 'live')
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.includes(LEGACY_MCP), false)
  assert.equal(carrierRows(patch), 0)
})

test('migrateProfile：bundle 已在 bundles 里时第二次什么都不写', () => {
  const dir = tempProfile({
    patch: [MCP_ROW, ''].join('\n'),
    manifest: { name: 'p', dsh: { profile: { bundles: [CUA_BUNDLE_NAME] } } },
  })
  const first = migrateProfile(dir, plainRuntime())
  assert.equal(first.changed, true)
  const second = migrateProfile(dir, plainRuntime())
  assert.equal(second.changed, false)
  assert.deepEqual(second.changes, [])
})

test('migrateProfile：现场快照（毒行 + bundles 已含该包）→ 只删行，不动 package.json', () => {
  const dir = tempProfile({
    patch: ['- insert:', '    - id: cua-bundle', "      name: '@deepseek-ai/dsh-cua-bundle'", ''].join('\n'),
    manifest: { name: 'p', dsh: { profile: { bundles: [CUA_BUNDLE_NAME] } } },
  })
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const result = migrateProfile(dir, plainRuntime())
  assert.equal(result.changed, true)
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').includes(CUA_BUNDLE_NAME), false)
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
})

test('migrateProfile：package.json 读不动时只告警，patch.yml 照样修好', () => {
  const dir = tempProfile({ patch: [MCP_ROW, ''].join('\n') })
  const result = migrateProfile(dir, plainRuntime())
  assert.equal(result.changed, true)
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').includes(LEGACY_MCP), false)
  assert.match(warningText(result), /无法把 .* 写进 dsh\.profile\.bundles/u)
})

test('migrateProfile：package.json 没有 dsh.profile 段时告警，不硬造结构', () => {
  const dir = tempProfile({ patch: [MCP_ROW, ''].join('\n'), manifest: { name: 'p' } })
  migrateProfile(dir, plainRuntime())
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh, undefined)
});

// ── list-agents：真实 profile 的插件行在 `- insert:` 下（缩进 14） ───────────────
// 发行 profile 的 tool-subagent-control 缩进就是 14；这两条用工整的嵌套形状确认
// 插入/删除都不依赖「顶层」这个前提。

test('list-agents 插入在嵌套缩进（14）下也保持同一层级', () => {
  const source = [
    '- insert:',
    '              - id: tool-subagent-control',
    "                name: '@deepseek-ai/dsh-tool-subagent-control'",
    '',
    '              - id: attachment-local',
    "                name: '@deepseek-ai/dsh-attachment-local'",
    '',
  ].join('\n')
  const result = migratePatchText(source, fakeRuntime({ resolvable: [LIST_AGENTS] }))
  assert.match(result.text, /\n {14}- id: tool-subagent-list-agents\n {16}name: '@deepseek-ai\/dsh-tool-subagent-control\/list-agents'/u)
  // 仍然只有一个 insert 头，原有两个兄弟项都在
  assert.equal((result.text.match(/^- insert:/gmu) ?? []).length, 1)
  assert.match(result.text, /- id: tool-subagent-control/u)
  assert.match(result.text, /- id: attachment-local/u)
  assert.equal(result.changes.filter(change => change.kind === 'list-agents').length, 1)
})

test('list-agents 删除在嵌套缩进（14）下也整块消失', () => {
  const source = [
    '- insert:',
    '              - id: tool-subagent-control',
    "                name: '@deepseek-ai/dsh-tool-subagent-control'",
    '              - id: tool-subagent-list-agents',
    "                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
    '',
  ].join('\n')
  const result = migratePatchText(source, plainRuntime())
  assert.equal(result.text.includes('tool-subagent-list-agents'), false)
  assert.match(result.text, /- id: tool-subagent-control\b/u)
  assert.equal(result.changes.filter(change => change.kind === 'list-agents').length, 1)
})
