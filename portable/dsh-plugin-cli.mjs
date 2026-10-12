// 便携版 `dsh plugin ...` 的入口（随包复制到 app/dsh-plugin-cli.mjs，由 dsh.exe 在首个参数为 plugin 时选用）。
//
// 上游 CLI 的插件管理把 pnpm 交给调用方：桌面版 dsh-desktop-host/lib/cli.js 传入随包 pnpm，
// 而直接跑 lib/bin.js 时退回 PATH 上的 pnpm —— 便携版只带 node，于是 `dsh plugin add/update`
// 一律 "pnpm was not found"。这里照桌面版的做法，把随包的 app/vendor/pnpm 交给同一个 runCli。
import { join } from 'node:path'
import { runCli } from './lib/bin.js'

await runCli({
  packageManager: {
    command: process.execPath,
    args: [join(import.meta.dirname, 'vendor', 'pnpm', 'bin', 'pnpm.mjs')],
  },
})
