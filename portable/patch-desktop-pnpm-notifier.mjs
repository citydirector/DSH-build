// patch-desktop-pnpm-notifier.mjs <upstream-repo-root>
//
// 让打包版桌面端的 pnpm 不再打印「Update available! x.y.z → a.b.c」。
//
// 那行提示来自 pnpm 自带的 update-notifier（dist/pnpm.mjs 的 checkForUpdates），不是我们写的：
// 它在 install / add 时把当前版本和 registry 的 latest 标签比一次，24 小时最多一次。
// 上游钉的是 11.x，而 npm 的 latest 早已指向 12.x，于是只要用户 dsh plugin add 就必然看到
// 「可升级」—— 但我们不能跟着升 12.x（工作区 pnpm run 会失败，见 ci/align-package-manager.mjs 头注释）。
//
// 关掉它的正确写法只有两种，实测于随包 pnpm：
//   --config.update-notifier=false     生效
//   PNPM_CONFIG_UPDATE_NOTIFIER=false  生效
//   npm_config_update_notifier=false   不生效（npm_config_ 只覆盖旧有 npm 同名字段，新设置项读不到）
// 这里用环境变量：上游把 packageManager.env 并进 pnpm 子进程的环境（plugin-manager 的
// operations.ts:317），所以不必改写 pnpm 的调用参数，也不会影响用户 PATH 上那份 pnpm。
//
// 两处入口都要打：
//   apps/desktop-host/src/cli.ts   —— dsh.cmd / dsh plugin，命令行安装
//   apps/desktop-host/src/index.ts —— 桌面应用内「安装插件」走的服务路径
// 锚点靠缩进区分（前者 6 空格、后者 8 空格），两文件各自恰好命中一次。
//
// 用法: node patch-desktop-pnpm-notifier.mjs <repo-root>
import { applyEditsToFiles } from './lib/apply-edits.mjs'

export const FILES = ['apps/desktop-host/src/cli.ts', 'apps/desktop-host/src/index.ts']

/** 关闭提示的两行注释 + 一行环境变量，缩进随所在块的层级走。 */
function environmentLine(indent) {
  return indent + "// DSH-build: pnpm's update-notifier compares against npm's latest tag (12.x while we pin 11.x);\n"
    + indent + '// for a bundled, non-upgradable pnpm that banner is pure noise.\n'
    + indent + "PNPM_CONFIG_UPDATE_NOTIFIER: 'false',\n"
}

export const EDITS = [
  {
    name: 'cli entry: silence pnpm update-notifier',
    file: FILES[0],
    from: "      env: {\n        ELECTRON_RUN_AS_NODE: '1',\n        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,\n",
    to: "      env: {\n        ELECTRON_RUN_AS_NODE: '1',\n        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,\n"
      + environmentLine('        '),
  },
  {
    name: 'desktop service entry: silence pnpm update-notifier',
    file: FILES[1],
    from: "        env: {\n          ELECTRON_RUN_AS_NODE: '1',\n          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,\n",
    to: "        env: {\n          ELECTRON_RUN_AS_NODE: '1',\n          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,\n"
      + environmentLine('          '),
  },
]

/**
 * 应用全部编辑（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: string[] }} 本次写入的编辑名。
 */
export function patchDesktopPnpmNotifier(root) {
  return applyEditsToFiles(root, EDITS, 'patch-desktop-pnpm-notifier')
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node patch-desktop-pnpm-notifier.mjs <repo-root>'); process.exit(2) }
  try {
    const { applied } = patchDesktopPnpmNotifier(root)
    console.log(applied.length === 0 ? 'patch-desktop-pnpm-notifier: already patched' : `patch-desktop-pnpm-notifier: applied ${applied.length} edit(s)\n  - ${applied.join('\n  - ')}`)
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) }
}
