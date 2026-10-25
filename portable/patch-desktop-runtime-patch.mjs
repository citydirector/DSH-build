// patch-desktop-runtime-patch.mjs <upstream-repo-root>
//
// 上游打包流程在内部会**再跑一次**构建。我们的 DSH-build 补丁 1/2（patch-native-code）
// 必须打在"已构建的 lib 上、且在运行时段打包成 tarball 之前"；内部重建会把补丁覆盖掉。
//
// 三处改动：
//   1. 给内部重建加显式开关 DSH_DESKTOP_SKIP_INTERNAL_BUILD=1（调用方自己构建 + 打补丁 + 打包）。
//      顺手把重建目标钉回 build:official：上游 0.2.1 起 unsigned 打包会改跑 `build --profile local`
//      （本地品牌），而我们的绿色包对外仍是 DeepSeek Harness，客户端 profile 必须是 official，
//      否则 build 记的构建记录与稍后打包校验的 profile 对不上。
//   2. 同一次改动把上游 unsigned 打包用的 apps/desktop/scripts/pack-local-packages.ts 里硬编码的
//      'local' 改成可配置 —— 该文件的 readClientBuildRecord 会拿 'local' 去比对构建记录，
//      与我们 official 的构建记录必然冲突。旧 pin（0.2.1-rc.2 之前）没有这个文件，跳过即可。
//   3. 把 desktop-files/refresh-client-build-record.ts 放进上游 scripts/：P1 会改动个别**客户端产物**
//      （如 packages/api/session-controller/lib/client.js），客户端构建记录需在其后重算，
//      否则上游 release:pack 的产物摘要校验会失败
//
// 用法: node portable/patch-desktop-runtime-patch.mjs <repo-root>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyEditsToFiles } from './lib/apply-edits.mjs'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 环境变量：跳过打包流程内部的重建。 */
export const SKIP_ENV = 'DSH_DESKTOP_SKIP_INTERNAL_BUILD'
/** 客户端构建记录驱动的落点（上游 scripts/ 内，供 `node --import tsx/esm` 直接跑）。 */
export const RECORD_DRIVER = 'scripts/dsh-build-refresh-client-record.ts'

/** 一处编辑：内部重建加开关，并把重建目标钉在 official profile。
 *  from 有两种形态：0.2.1 起上游把这一行改成按 unsigned 选 profile 的三元表达式。 */
export const REBUILD_EDIT = {
  name: 'packaging: allow skipping the internal rebuild so P1 survives into the runtime tarballs',
  file: 'apps/desktop/scripts/package-target.ts',
  from: [
    // 旧形态（<= 0.2.1-rc.2）
    "  await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)\n",
    // 新形态（0.2.1 起：unsigned 走本地 profile）
    "  await execute(invocation.unsigned ? ['run', 'build', '--profile', 'local'] : ['run', 'build:official'], buildEnv, REPOSITORY_ROOT)\n",
  ],
  to: '  // DSH-build: the caller builds, patches the built lib files, then packages; a rebuild here would\n'
    + '  // overwrite those patches before the runtime tarballs are assembled. The rebuild always targets the\n'
    + '  // official client profile: our unsigned packages are still shipped as DeepSeek Harness.\n'
    + `  if (process.env.${SKIP_ENV} !== '1') {\n`
    + "    await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)\n"
    + '  }\n',
}

/** 一处编辑：unsigned 打包校验的 profile 改由环境变量决定（0.2.1 起才有这个文件）。 */
export const LOCAL_PACK_EDIT = {
  name: 'local packaging: read the client build profile from the environment instead of hardcoding local',
  file: 'apps/desktop/scripts/pack-local-packages.ts',
  from: "  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')\n",
  to: '  // DSH-build: our unsigned packages keep the official client profile, so this step must verify the\n'
    + '  // profile the build actually recorded rather than a hardcoded local build.\n'
    + `  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), process.env.DSH_BUILD_CLIENT_PROFILE ?? 'local')\n`,
}

/**
 * 应用编辑并放置客户端记录驱动（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: string[], driverWritten: boolean, localPackSkipped: boolean }}
 */
export function patchDesktopRuntimePatch(root) {
  const applied = [...applyEditsToFiles(root, [REBUILD_EDIT], 'patch-desktop-runtime-patch').applied]
  // 旧 pin 没有 pack-local-packages.ts：那代上游的 unsigned 打包直接走 release:pack，不需要这一步。
  const hasLocalPack = existsSync(join(root, LOCAL_PACK_EDIT.file))
  if (hasLocalPack) applied.push(...applyEditsToFiles(root, [LOCAL_PACK_EDIT], 'patch-desktop-runtime-patch').applied)
  const source = join(HERE, 'desktop-files', 'refresh-client-build-record.ts')
  const target = join(root, RECORD_DRIVER)
  const body = readFileSync(source, 'utf8')
  const driverWritten = !existsSync(target) || readFileSync(target, 'utf8') !== body
  if (driverWritten) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  return { applied, driverWritten, localPackSkipped: !hasLocalPack }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node portable/patch-desktop-runtime-patch.mjs <repo-root>'); process.exit(2) }
  try {
    const { applied, driverWritten, localPackSkipped } = patchDesktopRuntimePatch(root)
    console.log('patch-desktop-runtime-patch: rebuild-gate=' + (applied.length > 0 ? 'applied(' + applied.length + ')' : 'already')
      + ' record-driver=' + (driverWritten ? 'written' : 'unchanged')
      + (localPackSkipped ? ' local-pack=absent(旧 pin，跳过)' : ''))
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) }
}
