import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { restoreIgnored } = await import('../ci/portable/restore-ignored.mjs')

/** 造一个 node_modules 目录：`packages` 落在根下，`ignored` 落在 .ignored 里。 */
function fixture({ packages = [], ignored = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'restore-ignored-'))
  const modules = join(root, 'node_modules')
  const write = (base, name) => {
    const target = join(base, ...name.split('/'))
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  for (const name of packages) write(modules, name)
  for (const name of ignored) write(join(modules, '.ignored'), name)
  return { root, modules }
}

test('还原：被隔离的包搬回 node_modules 原位置', () => {
  const { root, modules } = fixture({ ignored: ['abbrev', '@trycua/cua-driver'] })
  try {
    const { restored, kept } = restoreIgnored(modules)
    assert.deepEqual(restored.sort(), ['@trycua/cua-driver', 'abbrev'])
    assert.deepEqual(kept, [])
    assert.ok(existsSync(join(modules, 'abbrev', 'package.json')))
    assert.ok(existsSync(join(modules, '@trycua', 'cua-driver', 'package.json')))
    assert.equal(existsSync(join(modules, '.ignored', 'abbrev')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('还原：没有 .ignored 时安静返回，不抛错', () => {
  const { root, modules } = fixture({ packages: ['abbrev'] })
  try {
    const { restored, kept } = restoreIgnored(modules)
    assert.deepEqual(restored, [])
    assert.deepEqual(kept, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('还原：目标位置已有同名目录时不覆盖，记为保留', () => {
  const { root, modules } = fixture({ packages: ['abbrev'], ignored: ['abbrev'] })
  try {
    const { restored, kept } = restoreIgnored(modules)
    assert.deepEqual(restored, [])
    assert.deepEqual(kept, ['abbrev'])
    // 原位不动，隔离区也还在
    assert.ok(existsSync(join(modules, 'abbrev', 'package.json')))
    assert.ok(existsSync(join(modules, '.ignored', 'abbrev', 'package.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('还原：scope 目录里的普通文件不会被当成包', () => {
  const { root, modules } = fixture({ ignored: ['@trycua/cua-driver'] })
  try {
    writeFileSync(join(modules, '.ignored', '@trycua', 'README.txt'), 'x')
    const { restored } = restoreIgnored(modules)
    assert.deepEqual(restored, ['@trycua/cua-driver'])
    assert.deepEqual(readdirSync(join(modules, '.ignored', '@trycua')), ['README.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('还原：幂等，第二次运行无事可做', () => {
  const { root, modules } = fixture({ ignored: ['abbrev'] })
  try {
    assert.equal(restoreIgnored(modules).restored.length, 1)
    assert.equal(restoreIgnored(modules).restored.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('装配脚本：deploy 之后、patch-peers 之前先还原隔离包', () => {
  const script = readFileSync(new URL('../ci/portable/assemble-runtime.ps1', import.meta.url), 'utf8')
  const deploy = script.indexOf("Invoke-Native 'pnpm deploy'")
  const restore = script.indexOf("Invoke-Native 'restore-ignored'")
  const peers = script.indexOf("Invoke-Native 'patch-peers'")
  assert.ok(deploy > -1 && restore > -1 && peers > -1, '三个步骤都要在')
  assert.ok(deploy < restore, '还原必须在 deploy 之后（deploy 是搬走它们的那一步）')
  assert.ok(restore < peers, '还原必须在 patch-peers / patch-dep 之前（它们从根 node_modules 取货）')
})
