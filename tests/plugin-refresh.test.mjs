// portable/plugin-refresh.mjs 的单元测试（node:test）。
// 运行: npm test；设 DSH_TEST_SEMVER=<semver 包目录> 可改用真实 semver 交叉验证。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  applyPlan, blockedOf, buildPlan, formatPlan, isRegistrySpec, loadRuntime, parseNpmrc, pickTarget,
  registryFor, unmetDshPeers, upgradesOf,
} from '../portable/plugin-refresh.mjs'

const require = createRequire(import.meta.url)
const semver = process.env.DSH_TEST_SEMVER ? require(process.env.DSH_TEST_SEMVER) : require('./fixtures/mini-semver.cjs')

const OLD = '0.2.1-alpha.1'
const NEW = '0.2.1-alpha.2'

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

/** 造一个 DSH_HOME：profiles/<p>/package.json + node_modules 里的已装插件。 */
function makeHome(profiles) {
  const home = mkdtempSync(join(tmpdir(), 'plugin-refresh-'))
  for (const [profile, { dependencies, installed = {}, files = {} }] of Object.entries(profiles)) {
    const dir = join(home, 'profiles', profile)
    writeJson(join(dir, 'package.json'), { name: `dsh-profile-${profile}`, private: true, dependencies })
    for (const [name, manifest] of Object.entries(installed)) {
      writeJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'), { name, ...manifest })
    }
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  }
  return home
}

const pinned = version => ({ peerDependencies: { '@deepseek-ai/dsh': version } })

test('dsh peers follow upstream rules', () => {
  assert.deepEqual(unmetDshPeers(pinned(OLD), NEW, semver), { '@deepseek-ai/dsh': OLD })
  assert.deepEqual(unmetDshPeers(pinned(NEW), NEW, semver), {})
  assert.deepEqual(unmetDshPeers({ peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.1 <0.3.0' } }, NEW, semver), {})
  assert.deepEqual(unmetDshPeers({ peerDependencies: { '@deepseek-ai/dsh-base': 'workspace:^' } }, NEW, semver), {})
  // 非 dsh 的 peer 不参与判定
  assert.deepEqual(unmetDshPeers({ peerDependencies: { react: '99.0.0', '@deepseek-ai/other': '9.9.9' } }, NEW, semver), {})
  assert.deepEqual(unmetDshPeers({ peerDependencies: { '@deepseek-ai/dsh': '' } }, NEW, semver), { '@deepseek-ai/dsh': '' })
  assert.deepEqual(unmetDshPeers({}, NEW, semver), {})
})

test('registry specs vs everything else', () => {
  for (const spec of ['1.2.3', '^1.2.3', 'latest', '>=1 <2', '0.2.1-alpha.2']) assert.equal(isRegistrySpec(spec), true, spec)
  for (const spec of ['file:../x', 'link:x', 'workspace:*', 'git+https://x/y.git', 'github:a/b', 'a/b', 'https://x/y.tgz', 'npm:other@1', './x', 'C:\\x', 'D:/x']) {
    assert.equal(isRegistrySpec(spec), false, spec)
  }
})

test('pickTarget prefers latest, then newest stable, then newest prerelease', () => {
  const versions = {
    '1.0.0': pinned(OLD),
    '1.1.0': pinned(NEW),
    '1.2.0-beta.1': pinned(NEW),
    '1.3.0': { ...pinned(NEW), deprecated: 'broken' },
    '2.0.0': pinned('0.3.0'),
  }
  assert.equal(pickTarget({ versions, 'dist-tags': { latest: '1.1.0' } }, '1.0.0', NEW, semver), '1.1.0')
  assert.equal(pickTarget({ versions, 'dist-tags': { latest: '2.0.0' } }, '1.0.0', NEW, semver), '1.1.0')
  assert.equal(pickTarget({ versions: { '1.0.0': pinned(OLD), '1.1.0-rc.1': pinned(NEW) } }, '1.0.0', NEW, semver), '1.1.0-rc.1')
  // 只升不降：兼容版本比已装的旧，宁可不动
  assert.equal(pickTarget({ versions: { '0.9.0': pinned(NEW), '1.0.0': pinned(OLD) } }, '1.0.0', NEW, semver), undefined)
  assert.equal(pickTarget({ versions: {} }, '1.0.0', NEW, semver), undefined)
})

test('npmrc registries: env > profile > user > npmjs, scoped first', () => {
  const profile = parseNpmrc('# c\n@corp:registry=https://corp.example/npm\nregistry = "https://mirror.example/"\n')
  assert.deepEqual(profile, { default: 'https://mirror.example/', scopes: { '@corp': 'https://corp.example/npm' } })
  const user = parseNpmrc('registry=https://user.example')
  assert.equal(registryFor('@corp/x', [{ scopes: {} }, profile, user]), 'https://corp.example/npm/')
  assert.equal(registryFor('x', [{ scopes: {} }, profile, user]), 'https://mirror.example/')
  assert.equal(registryFor('x', [{ scopes: {} }, { scopes: {} }, user]), 'https://user.example/')
  assert.equal(registryFor('x', [{ default: 'https://env.example', scopes: {} }, profile]), 'https://env.example/')
  assert.equal(registryFor('x', [{ scopes: {} }]), 'https://registry.npmjs.org/')
})

const PACKUMENTS = {
  'dsh-plugin-a': { 'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': pinned(OLD), '1.1.0': pinned(NEW) } },
  'dsh-plugin-b': { 'dist-tags': { latest: '3.0.0' }, versions: { '3.0.0': pinned(OLD) } },
  'dsh-plugin-c': { 'dist-tags': { latest: '2.1.0' }, versions: { '2.0.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-0 <0.3.0' } }, '2.1.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-0 <0.3.0' } } } },
}

function fakeFetch(seen = []) {
  return async (name, registry) => {
    seen.push([name, registry])
    if (name === 'dsh-plugin-offline') throw new Error('ETIMEDOUT')
    return PACKUMENTS[name]
  }
}

function scenario() {
  return makeHome({
    web: {
      dependencies: {
        'dsh-plugin-a': '1.0.0', 'dsh-plugin-b': '3.0.0', 'dsh-plugin-c': '^2.0.0', 'local-plugin': 'file:../local',
        'dsh-plugin-offline': '1.0.0', 'never-installed': '1.0.0', 'dsh-plugin-exempt': '1.0.0',
      },
      installed: {
        'dsh-plugin-a': { version: '1.0.0', ...pinned(OLD) },
        'dsh-plugin-b': { version: '3.0.0', ...pinned(OLD) },
        'dsh-plugin-c': { version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-0 <0.3.0' } },
        'local-plugin': { version: '0.0.1', ...pinned(OLD) },
        'dsh-plugin-offline': { version: '1.0.0', ...pinned(OLD) },
        'dsh-plugin-exempt': { version: '1.0.0', ...pinned(OLD) },
      },
      files: {
        '.npmrc': 'registry=https://mirror.example/\n',
        'compatibility.json': JSON.stringify({ 'dsh-plugin-exempt@1.0.0': [NEW] }),
      },
    },
    empty: { dependencies: {} },
  })
}

test('default plan only touches plugins the new runtime rejects', async () => {
  const seen = []
  const plan = await buildPlan({ home: scenario(), runtimeVersion: NEW, semver, fetchPackument: fakeFetch(seen) })
  const status = Object.fromEntries(plan.profiles.find(p => p.profile === 'web').plugins.map(p => [p.name, p.status]))
  assert.deepEqual(status, {
    'dsh-plugin-a': 'upgrade',
    'dsh-plugin-b': 'blocked',
    'dsh-plugin-c': 'ok',
    'dsh-plugin-exempt': 'exempted',
    'dsh-plugin-offline': 'unknown',
    'local-plugin': 'blocked',
    'never-installed': 'skip',
  })
  assert.deepEqual(upgradesOf(plan).map(u => [u.profile, u.name, u.installed, u.target]), [['web', 'dsh-plugin-a', '1.0.0', '1.1.0']])
  assert.deepEqual(blockedOf(plan).map(b => b.name), ['dsh-plugin-b', 'local-plugin'])
  // 兼容插件默认不查 registry；查的时候用 profile 的 .npmrc
  assert.deepEqual(seen.map(([name]) => name).sort(), ['dsh-plugin-a', 'dsh-plugin-b', 'dsh-plugin-offline'])
  assert.ok(seen.every(([, registry]) => registry === 'https://mirror.example/'))
  const report = formatPlan(plan)
  assert.match(report, /将升级 {2}dsh-plugin-a@1\.0\.0 → 1\.1\.0/)
  assert.match(report, /不兼容 {2}dsh-plugin-b@3\.0\.0（没有兼容新运行时的版本）/)
  assert.doesNotMatch(report, /\[empty\]/)
})

test('--all also upgrades compatible plugins to their newest compatible version', async () => {
  const plan = await buildPlan({ home: scenario(), runtimeVersion: NEW, semver, fetchPackument: fakeFetch(), all: true })
  assert.deepEqual(upgradesOf(plan).map(u => `${u.name}@${u.target}`), ['dsh-plugin-a@1.1.0', 'dsh-plugin-c@2.1.0'])
})

test('a home without profiles plans nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'plugin-refresh-'))
  const plan = await buildPlan({ home, runtimeVersion: NEW, semver, fetchPackument: fakeFetch() })
  assert.deepEqual(plan.profiles, [])
  assert.equal(formatPlan(plan), '')
})

test('apply runs one CLI add per upgrade and reports each outcome', () => {
  const plan = {
    runtimeVersion: NEW,
    profiles: [
      { profile: 'web', plugins: [{ name: 'a', installed: '1.0.0', status: 'upgrade', target: '1.1.0' }, { name: 'b', status: 'ok' }] },
      { profile: 'desktop', plugins: [{ name: '@x/c', installed: '2.0.0', status: 'upgrade', target: '2.1.0' }] },
    ],
  }
  const calls = []
  const results = applyPlan(plan, ['node.exe', 'bin.js'], (command, args) => {
    calls.push([command, ...args])
    return args.at(-1) === '@x/c@2.1.0' ? 1 : 0
  })
  assert.deepEqual(calls, [
    ['node.exe', 'bin.js', 'plugin', '--profile', 'web', 'add', 'a@1.1.0'],
    ['node.exe', 'bin.js', 'plugin', '--profile', 'desktop', 'add', '@x/c@2.1.0'],
  ])
  assert.deepEqual(results.map(r => [r.name, r.ok]), [['a', true], ['@x/c', false]])
})

test('loadRuntime reads the version and semver from the runtime itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-runtime-'))
  // 便携版布局：app/ 本身就是 @deepseek-ai/dsh 包根
  writeJson(join(root, 'app', 'package.json'), { name: '@deepseek-ai/dsh' })
  const appBoot = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  writeJson(join(appBoot, 'package.json'), { name: '@deepseek-ai/dsh-app-boot', version: NEW, exports: { './package.json': './package.json' } })
  const fakeSemver = join(root, 'app', 'node_modules', 'semver')
  writeJson(join(fakeSemver, 'package.json'), { name: 'semver', main: 'index.js' })
  writeFileSync(join(fakeSemver, 'index.js'), 'module.exports = { valid: v => v, marker: "runtime" }')
  const portable = loadRuntime(join(root, 'app'))
  assert.equal(portable.version, NEW)
  assert.equal(portable.semver.marker, 'runtime')
  // 桌面版布局：dsh 树下 node_modules/@deepseek-ai/dsh
  const desktop = join(root, 'dsh')
  writeJson(join(desktop, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh' })
  writeJson(join(desktop, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), { name: '@deepseek-ai/dsh-app-boot', version: '0.2.2' })
  writeJson(join(desktop, 'node_modules', 'semver', 'package.json'), { name: 'semver', main: 'index.js' })
  writeFileSync(join(desktop, 'node_modules', 'semver', 'index.js'), 'module.exports = { valid: v => v }')
  assert.equal(loadRuntime(desktop).version, '0.2.2')
  assert.throws(() => loadRuntime(join(root, 'nowhere')), /不是 dsh 运行时目录/)
})
