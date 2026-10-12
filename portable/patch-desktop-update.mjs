// patch-desktop-update.mjs <upstream-repo-root>
//
// 唯一目的：让自建桌面端的**运行时**读不到更新策略，从而不轮询 Platform、不弹"必须更新"遮罩。
//
// 背景（dsh 0.1.7-rc.2 实查）：
//   • 产物 package.json 的 extraMetadata.dshMandatoryUpdatePolicy 由 electron-builder 配置注入，
//     运行时 apps/desktop/src/main.ts 正是从 manifest 读它（搜 `'dshMandatoryUpdatePolicy' in manifest`）
//     → 有值就建策略对象并周期请求
//     `/api/v0/check_client_update`（服务端 code 40005 → blocking 遮罩）。
//   • electron-updater feed：unsigned 构建下 publish 已是 null（`unsigned ? undefined : resolveDesktopAutoUpdateConfig(...)`
//     → `publish: update === undefined ? null : [...]`），产物里不会生成 app-update.yml，因此没有可更新来源。
//   • 构建期仍会用 DSH_DESKTOP_MANDATORY_UPDATE_* 校验策略配置（apps/desktop 的 .env.windows 提供），
//     但那个值只进 manifest 字段 —— 本补丁把它置为 undefined，JSON 序列化时该字段直接消失。
//
// 于是：无 feed + manifest 无策略 = 运行时不联网、不遮罩，也不存在"被官方更新覆盖掉补丁"的路径。
//
// 用法: node patch-desktop-update.mjs <repo-root>
import { applyEditsToFiles, editsApplied } from './lib/apply-edits.mjs'

/** 一处编辑：manifest 不再嵌入策略对象。 */
export const EDITS = [
  {
    name: 'packaged manifest: no embedded Platform policy',
    file: 'apps/desktop/scripts/electron-builder-config.mjs',
    // 上游先后出现过两种写法，按顺序尝试，恰好命中一种且只命中一次才算成功：
    //   1. 无条件嵌入（≤ 2026-10-07）
    //   2. 2604a4b 起：policy 为 undefined 时整个键省略（条件展开）
    from: [
      '      dshMandatoryUpdatePolicy: policy,\n',
      '      ...(policy === undefined ? {} : { dshMandatoryUpdatePolicy: policy }),\n',
    ],
    to: '      // DSH-build: never embed dshMandatoryUpdatePolicy so the runtime never constructs a mandatory-update policy.\n',
  },
]

/**
 * 应用全部编辑。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: string[] }} 已应用的编辑名。
 */
export function patchDesktopUpdate(root) {
  return applyEditsToFiles(root, EDITS, 'patch-desktop-update')
}

/** 幂等检查：所有编辑均已应用。 */
export function isPatched(root) {
  return editsApplied(root, EDITS)
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node patch-desktop-update.mjs <repo-root>'); process.exit(2) }
  if (isPatched(root)) { console.log('patch-desktop-update: already patched (no change)'); process.exit(0) }
  try {
    const { applied } = patchDesktopUpdate(root)
    console.log(`patch-desktop-update: applied ${applied.length} edit(s)`)
    for (const name of applied) console.log(`  - ${name}`)
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) }
}
