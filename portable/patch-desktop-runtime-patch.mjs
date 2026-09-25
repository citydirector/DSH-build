// patch-desktop-runtime-patch.mjs <upstream-repo-root>
//
// 上游 package-target.ts 在打包流程内部会**再跑一次** `pnpm run build:official`。
// 我们的 DSH-build 补丁 1/2（patch-native-code）必须打在"已构建的 lib 上、且在运行时段打包成
// tarball 之前"；内部重建会把补丁覆盖掉，于是产物里没有补丁 —— 这正是这个补丁要解决的顺序缺陷。
//
// 做法：给内部重建加一个显式环境开关
//   DSH_DESKTOP_SKIP_INTERNAL_BUILD=1 → 跳过内部 build:official
// 调用方（build-desktop.mjs）先自己构建、跑 P1、再带这个开关调用打包。
//
// 用法: node patch-desktop-runtime-patch.mjs <repo-root>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 环境变量：跳过打包流程内部的重建。 */
export const SKIP_ENV = 'DSH_DESKTOP_SKIP_INTERNAL_BUILD'

/** 一处编辑：内部重建加开关。 */
export const EDIT = {
  name: 'packaging: allow skipping the internal rebuild so P1 survives into the runtime tarballs',
  file: 'apps/desktop/scripts/package-target.ts',
  from: "  await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)\n",
  to: "  // DSH-build: the caller builds, patches the built lib files, then packages; a rebuild here would\n"
    + "  // overwrite those patches before the runtime tarballs are assembled.\n"
    + "  if (process.env.DSH_DESKTOP_SKIP_INTERNAL_BUILD !== '1') {\n"
    + "    await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)\n"
    + "  }\n",
}

/**
 * 应用编辑（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: boolean }} 是否写入。
 */
export function patchDesktopRuntimePatch(root) {
  const path = join(root, EDIT.file)
  const raw = readFileSync(path, 'utf8')
  if (raw.includes(EDIT.to)) return { applied: false }
  const occurrences = raw.split(EDIT.from).length - 1
  if (occurrences !== 1) {
    throw new Error(`patch-desktop-runtime-patch: ${EDIT.name}: expected exactly 1 occurrence in ${EDIT.file}, found ${occurrences}`)
  }
  writeFileSync(path, raw.replace(EDIT.from, EDIT.to))
  return { applied: true }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node patch-desktop-runtime-patch.mjs <repo-root>'); process.exit(2) }
  try {
    const { applied } = patchDesktopRuntimePatch(root)
    console.log(`patch-desktop-runtime-patch: ${applied ? 'applied' : 'already patched'}`)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}
