// patch-desktop-runtime-patch.mjs <upstream-repo-root>
//
// 上游打包流程在内部会**再跑一次** `pnpm run build:official`。我们的 DSH-build 补丁 1/2（patch-native-code）
// 必须打在"已构建的 lib 上、且在运行时段打包成 tarball 之前"；内部重建会把补丁覆盖掉。
//
// 两处改动：
//   1. 给内部重建加显式开关 DSH_DESKTOP_SKIP_INTERNAL_BUILD=1（调用方自己构建 + 打补丁 + 打包）
//   2. 把 desktop-files/refresh-client-build-record.ts 放进上游 scripts/：P1 会改动个别**客户端产物**
//      （如 packages/api/session-controller/lib/client.js），客户端构建记录需在其后重算，
//      否则上游 release:pack 的产物摘要校验会失败
//
// 用法: node portable/patch-desktop-runtime-patch.mjs <repo-root>
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 环境变量：跳过打包流程内部的重建。 */
const SKIP_ENV = 'DSH_DESKTOP_SKIP_INTERNAL_BUILD'
/** 客户端构建记录驱动的落点（上游 scripts/ 内，供 `node --import tsx/esm` 直接跑）。 */
const RECORD_DRIVER = 'scripts/dsh-build-refresh-client-record.ts'

/** 一处编辑：内部重建加开关。 */
const EDIT = {
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
 * 应用编辑并放置客户端记录驱动（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: boolean, driverWritten: boolean }}
 */
function patchDesktopRuntimePatch(root) {
  let applied = false
  const path = join(root, EDIT.file)
  const raw = readFileSync(path, 'utf8')
  if (!raw.includes(EDIT.to)) {
    const occurrences = raw.split(EDIT.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`patch-desktop-runtime-patch: ${EDIT.name}: expected exactly 1 occurrence in ${EDIT.file}, found ${occurrences}`)
    }
    writeFileSync(path, raw.replace(EDIT.from, EDIT.to))
    applied = true
  }
  const source = join(HERE, 'desktop-files', 'refresh-client-build-record.ts')
  const target = join(root, RECORD_DRIVER)
  const body = readFileSync(source, 'utf8')
  const driverWritten = !existsSync(target) || readFileSync(target, 'utf8') !== body
  if (driverWritten) writeFileSync(target, body)
  return { applied, driverWritten }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node portable/patch-desktop-runtime-patch.mjs <repo-root>'); process.exit(2) }
  try {
    const { applied, driverWritten } = patchDesktopRuntimePatch(root)
    console.log(`patch-desktop-runtime-patch: rebuild-gate=${applied ? 'applied' : 'already'} record-driver=${driverWritten ? 'written' : 'unchanged'}`)
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) }
}
