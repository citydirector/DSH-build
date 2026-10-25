// portable/check-bundles.mjs 的回归测试：名单搬家（app-boot → official-bundles）、改名（BUILTIN → HIDDEN）、
// 退役名单、以及“解析不出名单必须退出码 2”这条红线。
// 运行: node tests/check-bundles.test.mjs（node --test 下同样可跑）
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BUILTIN_NAMES,
  CLIENT_BUNDLE_SOURCE,
  HOST_BUNDLE_SOURCES,
  check,
  extractConst,
  firstList,
  makeTree,
} from '../portable/check-bundles.mjs'

const BASE = '{"name":"@deepseek-ai/dsh-base","version":"0.0.0"}'

// 0.2.1 之前的布局：宿主名单在 app-boot，客户端名单在 plugin-manager 的 client.js，名字叫 BUILTIN_PROFILE_BUNDLES。
const LEGACY_BOOT = [
  'const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];',
  'const OPTIONAL_BUNDLES = [',
  '  "@deepseek-ai/dsh-web-app"',
  '];',
  '',
].join('\n')
const LEGACY_CLIENT = [
  'const BUILTIN_PROFILE_BUNDLES = new Set([',
  '  "@deepseek-ai/dsh-base"',
  ']);',
  '',
].join('\n')

// 0.2.1 起的布局：名单整包搬进 @deepseek-ai/dsh-official-bundles，app-boot 只剩 re-export，
// 客户端那份改名 HIDDEN_BUNDLES。
const CURRENT_OFFICIAL = [
  'const RETIRED_BUNDLES: ReadonlySet<string> = new Set([',
  '  "@deepseek-ai/dsh-experimental-schedule-bundle",',
  '])',
  'const DEFAULT_PROFILE_BUNDLES: readonly string[] = ["@deepseek-ai/dsh-base"]',
  'const OPTIONAL_BUNDLES: readonly string[] = [',
  '  "@deepseek-ai/dsh-web-app"',
  ']',
  'const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([',
  '  "@deepseek-ai/dsh-base"',
  '])',
  '',
].join('\n')
const CURRENT_APP_BOOT = 'export { DEFAULT_PROFILE_BUNDLES } from "@deepseek-ai/dsh-official-bundles"\n'

function profile(base, bundles, dependencies) {
  const dir = join(base, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: dependencies ?? {},
    dsh: { profile: { bundles } },
  }))
  return dir
}

test('resolves the legacy layout from app-boot and the client bundle', () => {
  const t = makeTree('legacy', {
    '@deepseek-ai/dsh-app-boot/lib/index.js': LEGACY_BOOT,
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': LEGACY_CLIENT,
    '@deepseek-ai/dsh-base/package.json': BASE,
    '@deepseek-ai/dsh-web-app/package.json': BASE,
  })
  try {
    assert.equal(check(t.nm, profile(t.base, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])), 0)
  } finally { rmSync(t.base, { recursive: true, force: true }) }
})

test('resolves the 0.2.1 layout after the lists moved to official-bundles', () => {
  const t = makeTree('official', {
    '@deepseek-ai/dsh-official-bundles/lib/index.js': CURRENT_OFFICIAL,
    '@deepseek-ai/dsh-app-boot/lib/index.js': CURRENT_APP_BOOT,
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': 'import { HIDDEN_BUNDLES } from "@deepseek-ai/dsh-official-bundles"\nconsole.log(HIDDEN_BUNDLES)\n',
    '@deepseek-ai/dsh-base/package.json': BASE,
    '@deepseek-ai/dsh-web-app/package.json': BASE,
  })
  try {
    assert.equal(check(t.nm, profile(t.base, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])), 0)
  } finally { rmSync(t.base, { recursive: true, force: true }) }
})

test('new layout wins over the stale legacy copy', () => {
  const t = makeTree('both', {
    '@deepseek-ai/dsh-official-bundles/lib/index.js': CURRENT_OFFICIAL,
    // 旧位置里留着一份过时的 DEFAULT（只有 base），不能被优先采用
    '@deepseek-ai/dsh-app-boot/lib/index.js': 'const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-stale"];\n',
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': LEGACY_CLIENT,
    '@deepseek-ai/dsh-base/package.json': BASE,
    '@deepseek-ai/dsh-web-app/package.json': BASE,
  })
  try {
    const found = firstList(HOST_BUNDLE_SOURCES, ['DEFAULT_PROFILE_BUNDLES'], t.nm)
    assert.deepEqual(found.value, ['@deepseek-ai/dsh-base'])
    assert.match(found.from, /official-bundles/)
  } finally { rmSync(t.base, { recursive: true, force: true }) }
})

test('a missing bundle still fails with exit code 1 in the new layout', () => {
  const t = makeTree('missing', {
    '@deepseek-ai/dsh-official-bundles/lib/index.js': CURRENT_OFFICIAL,
    '@deepseek-ai/dsh-base/package.json': BASE,
  })
  try {
    assert.equal(check(t.nm, profile(t.base, ['@deepseek-ai/dsh-base'])), 1)
  } finally { rmSync(t.base, { recursive: true, force: true }) }
})

test('a retired bundle is not required to ship', () => {
  const t = makeTree('retired', {
    '@deepseek-ai/dsh-official-bundles/lib/index.js': CURRENT_OFFICIAL,
    '@deepseek-ai/dsh-base/package.json': BASE,
    '@deepseek-ai/dsh-web-app/package.json': BASE,
  })
  try {
    assert.equal(check(t.nm, profile(t.base, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-schedule-bundle'])), 0)
  } finally { rmSync(t.base, { recursive: true, force: true }) }
})

test('unparseable lists exit 2 instead of passing silently', () => {
  const t = makeTree('unknown', {
    '@deepseek-ai/dsh-official-bundles/lib/index.js': 'export const DEFAULT_PROFILE_BUNDLES = load()\n',
    '@deepseek-ai/dsh-app-boot/lib/index.js': 'export const DEFAULT_PROFILE_BUNDLES = load()\n',
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': 'export const HIDDEN_BUNDLES = load()\n',
  })
  try {
    assert.equal(check(t.nm, undefined), 2)
  } finally { rmSync(t.base, { recursive: true, force: true }) }
})

test('extractConst tolerates type annotations and both Set and array literals', () => {
  assert.deepEqual(extractConst('const A: readonly string[] = ["x", "y"]', 'A'), ['x', 'y'])
  assert.deepEqual(extractConst('const B: ReadonlySet<string> = new Set(["x"])', 'B'), ['x'])
  assert.equal(extractConst('const C = load()', 'C'), null)
  assert.deepEqual(BUILTIN_NAMES, ['HIDDEN_BUNDLES', 'BUILTIN_PROFILE_BUNDLES'])
  assert.ok(HOST_BUNDLE_SOURCES[0].path.includes('official-bundles'))
  assert.equal(CLIENT_BUNDLE_SOURCE.label, '@deepseek-ai/dsh-client-ui-plugin-manager')
})
