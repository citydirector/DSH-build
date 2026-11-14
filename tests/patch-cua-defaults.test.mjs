// portable/patch-cua-defaults.mjs 的单元测试（node:test，零依赖，独立 fixture）。
// 运行: node tests/patch-cua-defaults.test.mjs
//
// 测的是「默认启用落在真正的 profile 创建入口上」：web 模板（desktop 复用）、无模板名的
// DEFAULT_PROFILE_BUNDLES、以及上游自己那份断言。缺一处就会留下「desktop 启用、CLI 不启用」
// 的裂缝，所以三条一起测；锚点缺失必须抛错而不是静默跳过。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_EDITS, cuaDefaultsApplied, patchCuaDefaults } from '../portable/patch-cua-defaults.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP_ROOT = join(ROOT, '_skadi_temp')
const BUNDLES = 'packages/util/official-bundles/src/bundles.ts'
const SPEC = 'packages/util/official-bundles/tests/official-bundles.spec.ts'
const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'

const BUNDLES_SOURCE = `export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  },
}

export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']
`

const SPEC_SOURCE = `  expect(PROFILE_TEMPLATES).toEqual({
      acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
  })
`

function workspace() {
  mkdirSync(TEMP_ROOT, { recursive: true })
  const root = mkdtempSync(join(TEMP_ROOT, 'cua-defaults-'))
  mkdirSync(join(root, dirname(BUNDLES)), { recursive: true })
  mkdirSync(join(root, dirname(SPEC)), { recursive: true })
  writeFileSync(join(root, BUNDLES), BUNDLES_SOURCE)
  writeFileSync(join(root, SPEC), SPEC_SOURCE)
  return root
}

test('三条锚点一起命中：web 模板、DEFAULT_PROFILE_BUNDLES、上游断言', () => {
  const root = workspace()
  try {
    const { applied } = patchCuaDefaults(root)
    assert.deepEqual(applied.sort(), DEFAULT_EDITS.map((edit) => edit.name).sort())

    const bundles = readFileSync(join(root, BUNDLES), 'utf8')
    assert.match(bundles, new RegExp(`web: \\{\\s+bundles: \\['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${CUA_BUNDLE}'\\],`, 'u'))
    assert.match(bundles, new RegExp(`DEFAULT_PROFILE_BUNDLES[^=]*= \\['@deepseek-ai/dsh-base', '${CUA_BUNDLE}'\\]`, 'u'))
    // acp 模板不该被动：默认启用只针对 web/desktop 这条线
    assert.match(bundles, /acp: \{\n {4}bundles: \['@deepseek-ai\/dsh-base', '@deepseek-ai\/dsh-acp-app'\],/u)

    const spec = readFileSync(join(root, SPEC), 'utf8')
    assert.match(spec, new RegExp(`web: \\{ bundles: \\['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${CUA_BUNDLE}'\\] \\}`, 'u'))
    assert.equal(cuaDefaultsApplied(root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('幂等：第二次跑不再改动，文本完全一致', () => {
  const root = workspace()
  try {
    patchCuaDefaults(root)
    const first = readFileSync(join(root, BUNDLES), 'utf8')
    const second = patchCuaDefaults(root)
    assert.deepEqual(second.applied, [])
    assert.equal(readFileSync(join(root, BUNDLES), 'utf8'), first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺锚点：web 模板被上游改写成别的形状 → 抛错，不静默跳过', () => {
  const root = workspace()
  try {
    writeFileSync(join(root, BUNDLES), BUNDLES_SOURCE.replace("  web: {\n    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],\n  },", "  web: { bundles: ['@deepseek-ai/dsh-base'] },"))
    assert.throws(() => patchCuaDefaults(root), /expected exactly 1 occurrence/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺锚点：上游断言里的 web 期望被改写 → 抛错（源码与断言必须同步）', () => {
  const root = workspace()
  try {
    writeFileSync(join(root, SPEC), SPEC_SOURCE.replace(
      "      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },",
      "      web: { bundles: ['@deepseek-ai/dsh-base'] },",
    ))
    assert.throws(() => patchCuaDefaults(root), /expected exactly 1 occurrence/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('锚点出现多次 → 抛错（上游复制了模板定义）', () => {
  const root = workspace()
  try {
    writeFileSync(join(root, BUNDLES), BUNDLES_SOURCE + BUNDLES_SOURCE)
    assert.throws(() => patchCuaDefaults(root), /expected exactly 1 occurrence/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cuaDefaultsApplied：未打补丁时报 false（构建前哨不能自己骗自己）', () => {
  const root = workspace()
  try {
    assert.equal(cuaDefaultsApplied(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
