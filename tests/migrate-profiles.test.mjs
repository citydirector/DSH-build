// portable/migrate-profiles.mjs 的单元测试（node:test，零依赖）。
// 运行: node tests/migrate-profiles.test.mjs
//
// 这里守的是「迁移从更新器搬到了启动期」之后的两条底线：
//   1. 认不出参数就报错退出，绝不猜路径 —— 猜错就是改错文件。
//   2. 任何一步出问题都以「配置保持原样」收场，绝不拦启动。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listProfileDirectories, main, migrateAllProfiles, parseArgs } from '../portable/migrate-profiles.mjs'

const LIST_AGENTS = '@deepseek-ai/dsh-tool-subagent-control/list-agents'
const SUBAGENT = '@deepseek-ai/dsh-tool-subagent'

const PATCH = [
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

/** 造一棵最小的运行时：新版把 list_agents 并进主入口、只认 modelSelection / modelDiscovery。 */
function devRuntime(root) {
  const runtime = join(root, 'app')
  writeJson(join(runtime, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-rc.3' })
  writeJson(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent-control', 'package.json'), {
    name: '@deepseek-ai/dsh-tool-subagent-control', exports: { '.': './lib/index.js' },
  })
  writeJson(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'package.json'), {
    name: SUBAGENT, main: 'lib/index.js',
  })
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib'), { recursive: true })
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js'),
    'const Config = z.object({ modelSelection: z.boolean(), modelDiscovery: z.boolean() })')
  return runtime
}

/** 造一棵最小的 stable 运行时：list_agents 只在子路径里、subagent 只认 modelSelectionSettings。 */
function stableRuntime(root) {
  const runtime = join(root, 'app')
  writeJson(join(runtime, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.4' })
  writeJson(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent-control', 'package.json'), {
    name: '@deepseek-ai/dsh-tool-subagent-control',
    exports: { '.': './lib/index.js', './list-agents': './lib/list-agents.js' },
  })
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent-control', 'lib'), { recursive: true })
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent-control', 'lib', 'list-agents.js'), '')
  writeJson(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'package.json'), {
    name: SUBAGENT, main: 'lib/index.js',
  })
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib'), { recursive: true })
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js'),
    'const Config = z.object({ modelSelectionSettings: z.boolean() })')
  return runtime
}

function writeJson(path, body) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(body, undefined, 2))
}

/** 造一个 home，放进一个带 cordis.patch.yml 的 profile。 */
function makeHome(text = PATCH) {
  const root = mkdtempSync(join(tmpdir(), 'migrate-profiles-'))
  const home = join(root, 'data')
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.patch.yml'), text)
  return { root, home, profile, file: join(profile, 'cordis.patch.yml') }
}

// ── 参数解析 ────────────────────────────────────────────────────────────────
test('parseArgs 收齐必填项并把 --profile 收成数组', () => {
  const options = parseArgs(['--home', 'H', '--runtime', 'R', '--profile', 'desktop', '--profile', 'web', '--force', '--quiet'])
  assert.equal(options.home, 'H')
  assert.equal(options.runtime, 'R')
  assert.deepEqual(options.profiles, ['desktop', 'web'])
  assert.equal(options.force, true)
  assert.equal(options.quiet, true)
})

test('parseArgs 缺必填项和认不出的参数都直接报错', () => {
  assert.throws(() => parseArgs(['--runtime', 'R']), /缺少 --home/u)
  assert.throws(() => parseArgs(['--home', 'H']), /缺少 --runtime/u)
  assert.throws(() => parseArgs(['--home', 'H', '--runtime', 'R', '--nope']), /认不出的参数/u)
  // 取值缺失时必须报错，不能把下一个选项当成值吃掉
  assert.throws(() => parseArgs(['--home', '--runtime', 'R']), /缺少取值/u)
})

// ── profile 发现 ────────────────────────────────────────────────────────────
test('listProfileDirectories 只收带 cordis.patch.yml 的目录', () => {
  const { home, profile } = makeHome()
  mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'empty'), { recursive: true })
  const found = listProfileDirectories(home)
  assert.deepEqual(found.map(item => item.name), ['desktop'])
  assert.equal(found[0].directory, profile)
  assert.deepEqual(listProfileDirectories(home, ['web']), [])
})

test('listProfileDirectories 在没有 profiles 目录时返回空数组', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-empty-'))
  assert.deepEqual(listProfileDirectories(root), [])
})

// ── 迁移本身 ────────────────────────────────────────────────────────────────
test('新版运行时下，配置被迁到新口径', () => {
  const { root, home, file } = makeHome()
  const runtime = devRuntime(root)
  const outcome = migrateAllProfiles({ home, runtime })
  assert.equal(outcome.failed, 0)
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].changed, true)
  const after = readFileSync(file, 'utf8')
  assert.ok(!after.includes('list-agents'), '新运行时没有这条子路径，整块该被删掉')
  assert.match(after, /modelSelection: true/u)
  assert.match(after, /modelDiscovery: true/u)
})

test('stable 运行时下，已经删掉的行会被补回来', () => {
  // 从 dev 回退到 stable 时这一行必须回来：stable 的主入口不注册 list_agents，
  // 子路径是它唯一的提供者，缺了工具就消失。
  const { root, home, file } = makeHome([
    '- id: tool-subagent-control',
    "  name: '@deepseek-ai/dsh-tool-subagent-control'",
    '',
    '- id: tool-subagent',
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '  config:',
    '    modelSelection: true',
    '    modelDiscovery: true',
    '',
  ].join('\n'))
  const runtime = stableRuntime(root)
  migrateAllProfiles({ home, runtime })
  const after = readFileSync(file, 'utf8')
  assert.ok(after.includes('tool-subagent-list-agents'), 'stable 下这一行必须补回来')
  assert.ok(after.includes(LIST_AGENTS))
})

test('迁移是幂等的：同一份配置跑两遍，第二遍一个字节都不写', () => {
  const { root, home, file } = makeHome()
  const runtime = devRuntime(root)
  migrateAllProfiles({ home, runtime })
  const once = readFileSync(file, 'utf8')
  const second = migrateAllProfiles({ home, runtime })
  assert.equal(readFileSync(file, 'utf8'), once)
  assert.equal(second.results[0].changed, false)
})

test('迁移不写盘就不会留下空文件', () => {
  const { home } = makeHome(PATCH)
  // 配置已经是目标状态（没有可迁的），文件内容必须原样保留
  const { root } = makeHome(PATCH)
  const runtime = devRuntime(root)
  migrateAllProfiles({ home, runtime: join(root, 'nowhere') })
  assert.ok(existsSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml')))
})

test('一个 profile 读不动不影响另一个 profile 的迁移', () => {
  // 逐个 profile 兜住是这一层的底线：一个坏掉的 profile 不能带走其它的。
  const { root, home, file } = makeHome()
  const web = join(home, 'profiles', 'web')
  mkdirSync(join(web, 'cordis.patch.yml'), { recursive: true })   // 读不动：它不是文件
  const runtime = devRuntime(root)
  const outcome = migrateAllProfiles({ home, runtime, log: () => {} })
  assert.equal(outcome.failed, 0, '读不动的那个降级成无变化，不算失败')
  assert.deepEqual(outcome.results.map(item => item.profile), ['desktop', 'web'])
  assert.equal(outcome.results.find(item => item.profile === 'web').changed, false)
  assert.equal(outcome.results.find(item => item.profile === 'desktop').changed, true)
  assert.match(readFileSync(file, 'utf8'), /modelSelection: true/u)
})

// ── main 的退出码 ──────────────────────────────────────────────────────────
test('main 在参数不全时返回 2，不碰任何文件', () => {
  const { home, file } = makeHome()
  const before = readFileSync(file, 'utf8')
  assert.equal(main(['--home', home], () => {}), 2)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('main 在没有 profiles 目录时返回 0（不是失败）', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-nohome-'))
  const runtime = devRuntime(root)
  assert.equal(main(['--home', join(root, 'nothing'), '--runtime', runtime], () => {}), 0)
})

test('main 在运行时目录不存在时返回 0，配置保持原样', () => {
  const { root, home, file } = makeHome()
  const before = readFileSync(file, 'utf8')
  const code = main(['--home', home, '--runtime', join(root, 'nowhere')], () => {})
  assert.equal(code, 0)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('main 成功迁移时返回 0 并打印改了什么', () => {
  const { root, home, file } = makeHome()
  const runtime = devRuntime(root)
  const lines = []
  const code = main(['--home', home, '--runtime', runtime], line => lines.push(line))
  assert.equal(code, 0)
  assert.ok(lines.some(line => line.includes('modelSelectionSettings')), lines.join('\n'))
  assert.match(readFileSync(file, 'utf8'), /modelSelection: true/u)
})

