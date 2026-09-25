// patch-desktop-portable.mjs <upstream-repo-root>
//
// 把上游 Electron 桌面端改造成**绿色便携**形态（我们的习惯）：
//   1. 新增 apps/desktop/src/dsh-portable-bootstrap.ts（便携引导：见该文件头注释）
//   2. 在 apps/desktop/src/main.ts **第一行**插 `import './dsh-portable-bootstrap.ts'`，
//      保证它在任何其它模块副作用之前执行（ESM 按源码顺序求值）。
//
// 便携包只需在可执行文件旁放一个 `portable.flag`：
//   - DSH_HOME 指向包内 data/（dsh 侧全部状态、profiles/desktop、sessions、attachments）
//   - Electron userData/sessionData/cache/logs/crashDumps 全部落到包内 data/electron/*
//   - 若包内有 resources/dsh-build/migrate-sessions-v4.mjs，则按 VERSION 运行一次会话批量迁移
//     （标记 data/.migrations/session-v4-<version>.done，幂等；与便携版 launcher 同约定）
//
// 用法: node patch-desktop-portable.mjs <repo-root> [--files-dir <dir>]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP_SOURCE = join(HERE, 'desktop-files', 'dsh-portable-bootstrap.ts')
const BOOTSTRAP_TARGET = 'apps/desktop/src/dsh-portable-bootstrap.ts'
const MAIN = 'apps/desktop/src/main.ts'
const IMPORT_LINE = "import './dsh-portable-bootstrap.ts'\n"

/**
 * 应用便携补丁（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ added: string[], insertedImport: boolean }} 应用结果。
 */
export function patchDesktopPortable(root) {
  const mainPath = join(root, MAIN)
  const raw = readFileSync(mainPath, 'utf8')
  const added = []
  const bootstrapPath = join(root, BOOTSTRAP_TARGET)
  if (!existsSync(bootstrapPath) || readFileSync(bootstrapPath, 'utf8') !== readFileSync(BOOTSTRAP_SOURCE, 'utf8')) {
    copyFileSync(BOOTSTRAP_SOURCE, bootstrapPath)
    added.push(BOOTSTRAP_TARGET)
  }
  let insertedImport = false
  if (!raw.startsWith(IMPORT_LINE)) {
    if (raw.includes("from './dsh-portable-bootstrap.ts'")) {
      throw new Error('patch-desktop-portable: main.ts already imports the bootstrap, but not as the first line')
    }
    writeFileSync(mainPath, IMPORT_LINE + raw)
    insertedImport = true
  }
  return { added, insertedImport }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) {
    console.error('用法: node patch-desktop-portable.mjs <repo-root>')
    process.exit(2)
  }
  const result = patchDesktopPortable(resolve(root))
  console.log(`patch-desktop-portable: bootstrap=${result.added.length > 0 ? 'written' : 'unchanged'} import=${result.insertedImport ? 'inserted' : 'present'}`)
}
