// patch-desktop-runtime-patch 回归测试：新旧两代锚点都要认、缺失要大声失败、幂等、旧 pin 没有 local-pack 时跳过。
// 运行: npm test（node --test "tests/*.test.mjs"）
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  LOCAL_PACK_EDIT,
  REBUILD_EDIT,
  RECORD_DRIVER,
  SKIP_ENV,
  patchDesktopRuntimePatch,
} from '../portable/patch-desktop-runtime-patch.mjs'

// 0.2.1 之前的形态：无条件重建。
const LEGACY_PACKAGE_TARGET = [
  'async function buildAndPack(invocation, buildEnv, buildPaths, packArguments) {',
  "  await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)",
  '  // pack',
  '}',
  '',
].join('\n')

// 0.2.1 起的形态：unsigned 走本地 profile。
const CURRENT_PACKAGE_TARGET = [
  'async function buildAndPack(invocation, buildEnv, buildPaths, packArguments) {',
  "  await execute(invocation.unsigned ? ['run', 'build', '--profile', 'local'] : ['run', 'build:official'], buildEnv, REPOSITORY_ROOT)",
  '  // pack',
  '}',
  '',
].join('\n')

const PACK_LOCAL_PACKAGES = [
  "  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')",
  'readClientBuildRecord(root, environment)',
  '',
].join('\n')

function tree(packageTarget, options = {}) {
  const localPack = options.localPack !== false
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-patch-'))
  const target = join(root, 'apps/desktop/scripts/package-target.ts')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, packageTarget)
  if (localPack) {
    const local = join(root, LOCAL_PACK_EDIT.file)
    mkdirSync(dirname(local), { recursive: true })
    writeFileSync(local, PACK_LOCAL_PACKAGES)
  }
  return {
    root,
    target: () => readFileSync(target, 'utf8'),
    local: () => readFileSync(join(root, LOCAL_PACK_EDIT.file), 'utf8'),
    driver: () => readFileSync(join(root, RECORD_DRIVER), 'utf8'),
  }
}

test('rewrites the legacy unconditional rebuild into an opt-out that stays official', () => {
  const t = tree(LEGACY_PACKAGE_TARGET)
  try {
    const r = patchDesktopRuntimePatch(t.root)
    assert.equal(r.applied.length, 2)
    assert.equal(r.localPackSkipped, false)
    const out = t.target()
    // 顶层（两空格缩进）那行必须消失；四空格缩进的是被 if 包起来的那份，允许留下
    assert.doesNotMatch(out, /^ {2}await execute\(/m)
    const expected = ['  if (process.env.' + SKIP_ENV + " !== '1') {", "    await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)", '  }', ''].join('\n')
    assert.ok(out.includes(expected), out)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('rewrites the 0.2.1 unsigned-aware rebuild and pins the target back to official', () => {
  const t = tree(CURRENT_PACKAGE_TARGET)
  try {
    assert.equal(patchDesktopRuntimePatch(t.root).applied.length, 2)
    const out = t.target()
    assert.ok(!out.includes("['run', 'build', '--profile', 'local']"))
    assert.ok(out.includes("await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)"))
    assert.ok(out.includes('process.env.' + SKIP_ENV))
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('local packaging reads the profile from the environment instead of hardcoding local', () => {
  const t = tree(CURRENT_PACKAGE_TARGET)
  try {
    patchDesktopRuntimePatch(t.root)
    const out = t.local()
    assert.ok(!out.includes("), 'local')"))
    assert.ok(out.includes("process.env.DSH_BUILD_CLIENT_PROFILE ?? 'local'"))
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('skips the local packaging edit on an old pin that has no pack-local-packages.ts', () => {
  const t = tree(LEGACY_PACKAGE_TARGET, { localPack: false })
  try {
    const r = patchDesktopRuntimePatch(t.root)
    assert.equal(r.localPackSkipped, true)
    assert.equal(r.applied.length, 1)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('writes the client build record driver and does not rewrite it', () => {
  const t = tree(CURRENT_PACKAGE_TARGET)
  try {
    assert.equal(patchDesktopRuntimePatch(t.root).driverWritten, true)
    assert.ok(t.driver().includes('writeClientBuildRecord'))
    assert.equal(patchDesktopRuntimePatch(t.root).driverWritten, false)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('is idempotent', () => {
  const t = tree(CURRENT_PACKAGE_TARGET)
  try {
    patchDesktopRuntimePatch(t.root)
    const once = t.target()
    assert.equal(patchDesktopRuntimePatch(t.root).applied.length, 0)
    assert.equal(t.target(), once)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('an unknown rebuild anchor fails loudly', () => {
  const broken = CURRENT_PACKAGE_TARGET.replace(
    "  await execute(invocation.unsigned ? ['run', 'build', '--profile', 'local'] : ['run', 'build:official'], buildEnv, REPOSITORY_ROOT)",
    "  await execute(['run', 'build'], buildEnv, REPOSITORY_ROOT)",
  )
  const t = tree(broken)
  try { assert.throws(() => patchDesktopRuntimePatch(t.root), /expected exactly 1 occurrence/) }
  finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('the anchor stays pointed at the internal rebuild step', () => {
  assert.equal(REBUILD_EDIT.file, 'apps/desktop/scripts/package-target.ts')
  assert.match(REBUILD_EDIT.name, /rebuild/)
  assert.ok(Array.isArray(REBUILD_EDIT.from))
})
