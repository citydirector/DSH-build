// 便携版 `dsh plugin ...` 的入口（随包复制到 app/dsh-plugin-cli.mjs，由 dsh.exe 在首个参数为 plugin 时选用）。
//
// 上游 CLI 的插件管理把 pnpm 交给调用方：桌面版 dsh-desktop-host/lib/cli.js 传入随包 pnpm，
// 而直接跑 lib/bin.js 时退回 PATH 上的 pnpm —— 便携版只带 node，于是 `dsh plugin add/update`
// 一律 "pnpm was not found"。这里照桌面版的做法，把随包的 app/vendor/pnpm 交给同一个 runCli。
//
// PNPM_CONFIG_UPDATE_NOTIFIER：关掉 pnpm 自带的升级提示。update-notifier 在 `install`/`add` 时
// 拿当前版本比 registry 的 `latest` 标签（现在是 12.x，我们随包的是 11.x），于是每次安装插件都会
// 打一行「Update available!」—— 而 12.x 在工作区里跑 `pnpm run` 会失败，我们不能升它。
// 必须用 PNPM_CONFIG_ 前缀：npm_config_update_notifier 是旧字段名，pnpm 读不到（实测）。
import { join } from 'node:path'
import { runCli } from './lib/bin.js'

await runCli({
  packageManager: {
    command: process.execPath,
    args: [join(import.meta.dirname, 'vendor', 'pnpm', 'bin', 'pnpm.mjs')],
    env: { PNPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  },
})
