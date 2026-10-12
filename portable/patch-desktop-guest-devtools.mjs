// patch-desktop-guest-devtools.mjs <upstream-repo-root>
//
// 让打包版桌面端的内嵌浏览器页（browser-use / 预览用的 webview guest）也能打开 DevTools。
// 上游 `apps/desktop/src/browser-guests.ts` 给 guest 写死了 `devTools: !app.isPackaged`，
// 所以开发版能检查、打包版不能；主窗口的 F12 不受影响（main.ts 的 devTools: true）。
// 本补丁做两件事，幂等：
//   1. guest 的 webPreferences 在打包版也允许 DevTools（环境变量 DSH_DESKTOP_GUEST_DEVTOOLS=0 可关回去）；
//   2. guest 获得焦点时，F12 或 Ctrl+Shift+I 切换该 guest 自己的 DevTools（独立窗口）。
//      主窗口菜单里的 toggleDevTools 只作用于主窗口的 webContents，碰不到 guest，所以要单独绑定。
// 其余安全设置（sandbox / contextIsolation / webSecurity / 禁止 nodeIntegration 等）保持不变。
// 锚点缺失或命中多次直接抛错：宁可构建失败，也不静默产出一个半补丁的包。
//
// 用法: node patch-desktop-guest-devtools.mjs <repo-root>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FILE = 'apps/desktop/src/browser-guests.ts'

export const EDITS = [
  {
    name: 'guest webPreferences: allow DevTools in packaged builds',
    from: '        devTools: !app.isPackaged,\n',
    // 保留对 app 的引用：上游开了 noUnusedLocals，删掉 app.isPackaged 会让 `app` 导入变成未使用而编译失败。
    to: "        // DSH-build: inspect embedded browser pages in packaged builds too; DSH_DESKTOP_GUEST_DEVTOOLS=0 opts out.\n"
      + "        devTools: !app.isPackaged || process.env.DSH_DESKTOP_GUEST_DEVTOOLS !== '0',\n",
  },
  {
    name: 'guest input: F12 / Ctrl+Shift+I toggles the guest DevTools',
    from: '        lease.releaseInput = attachInput(guest, id)\n',
    to: '        lease.releaseInput = attachInput(guest, id)\n'
      + '        // DSH-build: the window menu toggles only the main webContents; give the guest its own toggle.\n'
      + "        guest.on('before-input-event', (event, input) => {\n"
      + "          if (input.type !== 'keyDown' || input.isAutoRepeat) return\n"
      + "          const key = input.key.toLowerCase()\n"
      + "          const toggle = (key === 'f12' && !input.control && !input.shift && !input.alt && !input.meta)\n"
      + "            || (key === 'i' && input.control && input.shift && !input.alt)\n"
      + '          if (!toggle) return\n'
      + '          event.preventDefault()\n'
      + "          if (guest.isDevToolsOpened()) guest.closeDevTools()\n"
      + "          else guest.openDevTools({ mode: 'detach' })\n"
      + '        })\n',
  },
]

/**
 * 应用全部编辑（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ applied: string[] }} 本次写入的编辑名。
 */
export function patchDesktopGuestDevtools(root) {
  const path = join(root, FILE)
  let raw = readFileSync(path, 'utf8')
  const applied = []
  for (const edit of EDITS) {
    if (raw.includes(edit.to)) continue
    const occurrences = raw.split(edit.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`patch-desktop-guest-devtools: ${edit.name}: expected exactly 1 occurrence in ${FILE}, found ${occurrences}`)
    }
    raw = raw.replace(edit.from, edit.to)
    applied.push(edit.name)
  }
  if (applied.length > 0) writeFileSync(path, raw)
  return { applied }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) { console.error('用法: node patch-desktop-guest-devtools.mjs <repo-root>'); process.exit(2) }
  try {
    const { applied } = patchDesktopGuestDevtools(root)
    console.log(applied.length === 0 ? 'patch-desktop-guest-devtools: already patched' : `patch-desktop-guest-devtools: applied ${applied.length} edit(s)\n  - ${applied.join('\n  - ')}`)
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) }
}
