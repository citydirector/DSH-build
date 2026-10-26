import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  environmentValue,
  expandPercentReferences,
  mergeUserEnvironment,
  parseRegQueryEnvironment,
  refreshUserEnvironment,
} from '../portable/desktop-files/dsh-user-environment.ts'
import { DESKTOP_FILES, patchDesktopPortable } from '../portable/patch-desktop-portable.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一份真实 `reg query HKCU\Environment` 输出，覆盖每种值类型。 */
const REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools',
  '    ANYSEARCH_API_KEY    REG_SZ    as_sk_abc123',
  '    BIFROST_KEY    REG_SZ    ',
  '    BROKEN    REG_BINARY    00FF00FF',
  '    ZERO    REG_NONE    ',
  '    THREADS    REG_DWORD    0x8',
  '    MULTI    REG_MULTI_SZ    alpha',
  'beta',
  'gamma',
  '',
  '    AFTER    REG_SZ    tail',
  '',
].join('\r\n')

test('解析：每种值类型都读出来，MULTI_SZ 的续行归到同一个名字', () => {
  const entries = parseRegQueryEnvironment(REG_OUTPUT)
  assert.deepEqual(entries.map((entry) => entry.name),
    ['Path', 'ANYSEARCH_API_KEY', 'BIFROST_KEY', 'BROKEN', 'ZERO', 'THREADS', 'MULTI', 'AFTER'])
  const multi = entries.find((entry) => entry.name === 'MULTI')
  assert.equal(multi.kind, 'REG_MULTI_SZ')
  assert.deepEqual(multi.values, ['alpha', 'beta', 'gamma'])
  // 值里带空格的不能被切断
  assert.deepEqual(entries.find((entry) => entry.name === 'Path').values,
    ['%USERPROFILE%\\bin;C:\\Tools'])
})

test('解析：空输出和只有键头的输出都得到空列表', () => {
  assert.deepEqual(parseRegQueryEnvironment(''), [])
  assert.deepEqual(parseRegQueryEnvironment('\r\nHKEY_CURRENT_USER\\Environment\r\n'), [])
})

test('取值：REG_BINARY / REG_NONE / 空字符串都不进环境', () => {
  const lookup = () => undefined
  const byName = Object.fromEntries(parseRegQueryEnvironment(REG_OUTPUT).map((e) => [e.name, e]))
  assert.equal(environmentValue(byName.BROKEN, lookup), undefined)
  assert.equal(environmentValue(byName.ZERO, lookup), undefined)
  assert.equal(environmentValue(byName.BIFROST_KEY, lookup), undefined)
  assert.equal(environmentValue(byName.ANYSEARCH_API_KEY, lookup), 'as_sk_abc123')
})

test('取值：REG_DWORD 去掉 0x 前缀，REG_MULTI_SZ 用 ; 连接', () => {
  const lookup = () => undefined
  const byName = Object.fromEntries(parseRegQueryEnvironment(REG_OUTPUT).map((e) => [e.name, e]))
  assert.equal(environmentValue(byName.THREADS, lookup), '8')
  assert.equal(environmentValue(byName.MULTI, lookup), 'alpha;beta;gamma')
})

test('取值：REG_EXPAND_SZ 展开 %NAME%，未知名字原样保留', () => {
  assert.equal(expandPercentReferences('%A%/x/%B%', (n) => (n === 'A' ? 'one' : undefined)), 'one/x/%B%')
  const lookup = (name) => (name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined)
  const entry = { name: 'Path', kind: 'REG_EXPAND_SZ', values: ['%USERPROFILE%\\bin'] }
  assert.equal(environmentValue(entry, lookup), 'C:\\Users\\me\\bin')
})

test('合并：逐条写入目标对象并返回条数', () => {
  const target = { Path: 'stale' }
  const applied = mergeUserEnvironment(parseRegQueryEnvironment(REG_OUTPUT), target, (name) => target[name])
  // Path / ANYSEARCH_API_KEY / THREADS / MULTI / AFTER，其余三个（空串、BINARY、NONE）不进环境
  assert.equal(applied, 5)
  assert.equal(target.ANYSEARCH_API_KEY, 'as_sk_abc123')
  assert.equal(target.AFTER, 'tail')
  assert.equal(target.BROKEN, undefined)
  assert.equal(target.BIFROST_KEY, undefined)
})

test('合并：%VAR% 可以引用本轮已刷新的名字', () => {
  const target = {}
  const entries = [
    { name: 'BASE', kind: 'REG_SZ', values: ['D:\\root'] },
    { name: 'DERIVED', kind: 'REG_EXPAND_SZ', values: ['%BASE%\\sub'] },
  ]
  mergeUserEnvironment(entries, target)
  assert.equal(target.DERIVED, 'D:\\root\\sub')
})

test('刷新：读不到注册表时返回 0 且不抛错', () => {
  assert.equal(refreshUserEnvironment(() => undefined), 0)
})

test('刷新：非 win32 平台直接返回 0', (t) => {
  if (process.platform === 'win32') {
    t.skip('仅在非 Windows 上有意义')
    return
  }
  assert.equal(refreshUserEnvironment(() => REG_OUTPUT), 0)
})

test('便携补丁：bootstrap 与注册表读取器一起落位', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-portable-patch-'))
  try {
    mkdirSync(join(root, 'apps/desktop/src'), { recursive: true })
    writeFileSync(join(root, 'apps/desktop/src/main.ts'), "import { app } from 'electron'\n")
    const result = patchDesktopPortable(root)
    assert.deepEqual(result.added, DESKTOP_FILES.map(([, target]) => target))
    assert.equal(result.insertedImport, true)
    for (const [source, target] of DESKTOP_FILES) {
      assert.equal(readFileSync(join(root, target), 'utf8'),
        readFileSync(join(HERE, '..', 'portable', 'desktop-files', source), 'utf8'))
    }
    const main = readFileSync(join(root, 'apps/desktop/src/main.ts'), 'utf8')
    assert.equal(main.split('\n')[0], "import './dsh-portable-bootstrap.ts'")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('便携补丁：第二次运行不再写文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-portable-patch-'))
  try {
    mkdirSync(join(root, 'apps/desktop/src'), { recursive: true })
    writeFileSync(join(root, 'apps/desktop/src/main.ts'), "import { app } from 'electron'\n")
    patchDesktopPortable(root)
    const second = patchDesktopPortable(root)
    assert.deepEqual(second.added, [])
    assert.equal(second.insertedImport, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bootstrap 在 DSH_HOME 赋值之前先刷新环境', () => {
  const source = readFileSync(join(HERE, '..', 'portable', 'desktop-files', 'dsh-portable-bootstrap.ts'), 'utf8')
  const refresh = source.indexOf('refreshUserEnvironment()')
  const home = source.indexOf("process.env.DSH_HOME = dataRoot")
  assert.ok(refresh > 0, 'bootstrap 必须调用 refreshUserEnvironment')
  assert.ok(home > refresh, '刷新必须发生在 DSH_HOME 赋值之前，否则用户设的同名变量会被覆盖')
})
