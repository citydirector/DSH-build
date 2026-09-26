// patch-desktop-computer-use.mjs <upstream-repo-root>
//
// 把官方 computer-use 的两个包声明成桌面端的**运行时依赖**，好让 electron-builder 把它们
// 连同 SDK（@trycua/cua-driver + 平台原生二进制）一起打进 resources/app.asar：
//
//   @deepseek-ai/dsh-computer-use                              提供 computerUse 服务的注册表
//   @deepseek-ai/dsh-experimental-computer-use-cua-driver-native 原生提供方（进程内 Cua Driver）
//
// 为什么必须在打包前声明：桌面包里的应用是 asar（打包后再往里塞东西 = 要动 asar 结构，
// 原生 .node 还得同时落到 app.asar.unpacked），所以只能走依赖闭包。声明成 workspace 依赖后，
// electron-builder 会把提供方的 registry 依赖 @trycua/cua-driver 一并带上，.node 自动 unpack。
//
// 便携版那边不需要这个脚本：那里的 app/ 是散目录，构建期用 patch-peers + patch-dep 直接补齐
// （见 workflow 的 "Patch runtime deps" 与 "Assert the Cua Driver SDK shipped"）。两条路都
// 保证「版本与 app 同生共死」，于是不必在 profile 里单独装插件、也不必每次更新后重钉版本。
//
// 用法: node patch-desktop-computer-use.mjs <repo-root>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_PACKAGE = 'apps/desktop/package.json'

/** 必须出现在桌面产物里的两个包：注册表在前（提供方 inject 它提供的服务）。 */
export const RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-computer-use',
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
]

/**
 * 幂等地把 runtime 依赖写进桌面端 manifest。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ added: string[], packagePath: string }} 本次新增的包名与改动的文件。
 */
export function patchDesktopComputerUse(root) {
  const packagePath = join(root, APP_PACKAGE)
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (manifest.dependencies === undefined || typeof manifest.dependencies !== 'object' || manifest.dependencies === null) {
    throw new Error(`patch-desktop-computer-use: ${APP_PACKAGE} 没有 dependencies 对象，上游改了结构？`)
  }
  const added = []
  for (const name of RUNTIME_PACKAGES) {
    if (manifest.dependencies[name] !== undefined) continue
    manifest.dependencies[name] = 'workspace:*'
    added.push(name)
  }
  if (added.length > 0) writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n')
  return { added, packagePath }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('用法: node patch-desktop-computer-use.mjs <upstream-repo-root>')
  const { added } = patchDesktopComputerUse(root)
  console.log(added.length === 0
    ? 'patch-computer-use: 依赖已声明，无改动'
    : 'patch-computer-use: 新增依赖 ' + added.join(', '))
}
