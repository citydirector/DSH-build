// patch-desktop-toolchain.mjs <upstream-repo-root>
//
// 我们的产物是**解包目录**（electron-builder 的 dir 目标 + 免签名），不生成 NSIS 安装器。
// 上游有两处"只服务安装器"的准备步骤，在 Windows 上无条件执行，且都需要本机没有的工具链：
//   1. 工具链预检用 vswhere 找 Visual Studio C++ Build Tools（编译安装器 helper）
//   2. electron-builder 的 beforeBuild 调 prepare-windows-installer.ps1
//      （要 VS C++ Build Tools + Windows SDK，编译 installer-ui/window-frame.dll 等）
// 两处都没有 --dir/--unsigned 豁免，于是这里加一个显式环境开关：
//   DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN=1 → 跳过上述两项（tar 预检保留）
//
// 注意：这不改变上游默认行为，只是让"只出目录"的构建路径可选；安装器/签名路径仍属上游。
//
// 用法: node patch-desktop-toolchain.mjs <repo-root>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 环境变量：跳过"安装器专用"的准备步骤。 */
export const SKIP_ENV = 'DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN'

/** 三处编辑：工具链预检、安装器 UI 准备、打包后冒烟（都由同一类"产物路径不需要"开关控制）。 */
export const EDITS = [
  {
    name: 'toolchain: allow skipping the installer-only Visual Studio probe',
    file: 'apps/desktop/scripts/desktop-toolchain-preflight.ts',
    from: "  if (platform === 'win32') failures.push(...await probeWindowsInstallerToolchain(environment))\n",
    to: "  // DSH-build: a directory-only unsigned build compiles no installer helper, so the Visual Studio\n"
      + "  // probe is optional; set DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN=1 to skip it.\n"
      + "  if (platform === 'win32' && environment.DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN !== '1') {\n"
      + "    failures.push(...await probeWindowsInstallerToolchain(environment))\n"
      + "  }\n",
  },
  {
    name: 'packaging: skip installer UI preparation for a directory-only build',
    file: 'apps/desktop/scripts/electron-builder-config.mjs',
    from: "      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',\n"
      + "        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),\n"
      + "        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {\n"
      + "        env: scrubWindowsSigningEnvironment(env), windowsHide: true,\n"
      + "      })\n",
    to: "      // DSH-build: installer UI preparation needs Visual Studio C++ Build Tools + a Windows SDK and is\n"
      + "      // only consumed by the NSIS installer; skip it when producing the unpacked directory.\n"
      + "      if (env.DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN !== '1') {\n"
      + "        await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',\n"
      + "          fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),\n"
      + "          '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {\n"
      + "          env: scrubWindowsSigningEnvironment(env), windowsHide: true,\n"
      + "        })\n"
      + "      }\n",
  },
  {
    name: 'packaging: allow skipping the post-package runtime smoke',
    file: 'apps/desktop/scripts/package-target.ts',
    from: "    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', ...(invocation.unsigned ? ['--unsigned'] : [])], targetEnv)\n",
    to: "    // DSH-build: this smoke loads the packaged Python runtime (lxml); under a deep build directory its\n"
      + "    // site-packages paths exceed MAX_PATH and the DLL load fails with ERROR_FILENAME_EXCED_RANGE — an\n"
      + "    // environment limit, not an artifact defect. The pre-package runtime smoke in prepare:dsh still runs.\n"
      + "    if (environment.DSH_DESKTOP_SKIP_PACKAGED_SMOKE !== '1') {\n"
      + "      await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', ...(invocation.unsigned ? ['--unsigned'] : [])], targetEnv)\n"
      + "    }\n",
  },
]

/**
 * 应用全部编辑（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: string[] }} 本次写入的编辑名。
 */
export function patchDesktopToolchain(root) {
  const applied = []
  for (const edit of EDITS) {
    const path = join(root, edit.file)
    const raw = readFileSync(path, 'utf8')
    if (raw.includes(edit.to)) continue
    const occurrences = raw.split(edit.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`patch-desktop-toolchain: ${edit.name}: expected exactly 1 occurrence in ${edit.file}, found ${occurrences}`)
    }
    writeFileSync(path, raw.replace(edit.from, edit.to))
    applied.push(edit.name)
  }
  return { applied }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node patch-desktop-toolchain.mjs <repo-root>'); process.exit(2) }
  try {
    const { applied } = patchDesktopToolchain(root)
    console.log(applied.length === 0 ? 'patch-desktop-toolchain: already patched' : `patch-desktop-toolchain: applied ${applied.length} edit(s)\n  - ${applied.join('\n  - ')}`)
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) }
}
