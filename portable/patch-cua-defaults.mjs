// patch-cua-defaults.mjs —— 让新 Computer Use 链成为新 profile 的默认组成部分。
//
// 用法：node portable/patch-cua-defaults.mjs <upstream-root>
//       node portable/patch-cua-defaults.mjs --check <upstream-root>   （只读，0=已打/可打）
//
// Why：上游把 `@deepseek-ai/dsh-cua-bundle` 放在 OPTIONAL_BUNDLES 里——装了但默认不启用。
// 本发行要求「新插件默认完整启用、仍保留应用授权」。默认启用必须落在**真正创建 profile 的
// 入口**上：
//   - `PROFILE_TEMPLATES.web.bundles`：web 与 desktop 都走这条模板
//     （apps/desktop/src/project-manager.ts 直接用 `PROFILE_TEMPLATES.web` 建 profile，
//      apps/cli/src/profile.ts 与 packages/boot/app-boot/src/profile.ts 也读它）；
//   - `DEFAULT_PROFILE_BUNDLES`：`dsh plugin` 对没有模板名的 profile 用这条。
// 只改其中一处会留下「desktop 默认启用、CLI 新建 profile 不启用」或反过来的裂缝。
//
// 为什么不改 OPTIONAL_BUNDLES / 插件页：那两处决定的是「可选项怎么展示」，不是默认值；
// 把 cua-bundle 从 OPTIONAL 里删掉反而会让它从插件页消失，用户失去关闭与重开的入口。
//
// 为什么同时改上游测试断言：构建树里 `PROFILE_TEMPLATES` 的期望值写在
// packages/util/official-bundles/tests/official-bundles.spec.ts。不改它，构建树会处于
// 「源码说默认启用、测试说默认不启用」的自相矛盾状态——那种失败会被当成噪声忽略。
//
// 关闭开关：构建时 export DSH_SKIP_CUA_DEFAULTS=1（只用于对照旧发行行为；CI 不设）。
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEditsToFiles, applyEditsToText, editsApplied } from './lib/apply-edits.mjs'

const BUNDLES = 'packages/util/official-bundles/src/bundles.ts'
const SPEC = 'packages/util/official-bundles/tests/official-bundles.spec.ts'
const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'

/** 默认启用：web 模板（desktop 复用）与「无模板名」的默认入口。 */
export const DEFAULT_EDITS = [
  {
    name: 'web-profile-template-includes-cua-bundle',
    file: BUNDLES,
    from: '  web: {\n    bundles: [\'@deepseek-ai/dsh-base\', \'@deepseek-ai/dsh-web-app\'],\n  },',
    to: `  web: {\n    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${CUA_BUNDLE}'],\n  },`,
  },
  {
    name: 'default-profile-bundles-include-cua-bundle',
    file: BUNDLES,
    from: 'export const DEFAULT_PROFILE_BUNDLES: readonly string[] = [\'@deepseek-ai/dsh-base\']',
    to: `export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '${CUA_BUNDLE}']`,
  },
  {
    name: 'official-bundles-spec-expects-cua-bundle',
    file: SPEC,
    from: '      web: { bundles: [\'@deepseek-ai/dsh-base\', \'@deepseek-ai/dsh-web-app\'] },',
    to: `      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${CUA_BUNDLE}'] },`,
  },
]

/**
 * 应用默认启用补丁。
 * @param {string} root - 上游构建树根目录。
 * @param {{edits?: typeof DEFAULT_EDITS}} [options]
 * @returns {{applied: string[]}}
 */
export function patchCuaDefaults(root, options = {}) {
  const edits = options.edits ?? DEFAULT_EDITS
  return applyEditsToFiles(root, edits, 'patch-cua-defaults')
}

/** 是否已全部应用。 */
export function cuaDefaultsApplied(root, edits = DEFAULT_EDITS) {
  return editsApplied(root, edits)
}

function main(argv) {
  const check = argv.includes('--check')
  const root = argv.find((token) => !token.startsWith('--'))
  if (root === undefined) throw new Error('用法: node patch-cua-defaults.mjs [--check] <upstream-root>')
  if (process.env.DSH_SKIP_CUA_DEFAULTS === '1' && !check) {
    console.log('patch-cua-defaults: DSH_SKIP_CUA_DEFAULTS=1，跳过默认启用补丁')
    return 0
  }
  if (check) {
    // 只读：对每个文件试算，不写盘。任何一条会改动，就说明尚未全部应用。
    const pending = []
    for (const file of [...new Set(DEFAULT_EDITS.map((edit) => edit.file))]) {
      const text = readFileSync(join(root, file), 'utf8')
      const result = applyEditsToText(text, DEFAULT_EDITS.filter((edit) => edit.file === file), 'patch-cua-defaults', file)
      pending.push(...result.applied)
    }
    console.log(`patch-cua-defaults: ${pending.length === 0 ? '已应用' : `可应用（${pending.join(', ')}）`}`)
    return pending.length === 0 ? 0 : 1
  }
  const { applied } = patchCuaDefaults(root)
  console.log(applied.length === 0
    ? 'patch-cua-defaults: 无需改动（已应用）'
    : `patch-cua-defaults: 已启用 ${applied.join(', ')}`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
