// patch-windows-acl-runner-console.mjs <upstream-repo-root>
//
// 源码补丁：在 `build:official` **之前**把修复插进上游 TypeScript，让构建产物自带修复。
// 与 P1/P4（打在已构建 lib 上）不同，这里打的是 `packages/sandbox/sandbox-windows-acl/src/`，
// 因此不需要碰压缩后的 lib、也不需要重打包 app.asar —— 打包器打进去的就是已修好的代码。
//
// Why: `AclSandbox` 用 `CreateProcessAsUserW(token, …, creationFlags = 0, …)` 起受限子进程
// （见 `spawn.ts` → `@deepseek-ai/dsh-win32-process` 的 `createRestrictedProcess(..., 0, ...)`），
// `creationFlags = 0` 表示子进程**直接挂到「跑 runner 的那个进程」的控制台**上。于是判别的不是
// 父进程有没有控制台，而是 **runner 自己有没有**：
//   - 真 node / console 子系统映像：即使 `CREATE_NO_WINDOW` 也会拿到一个无窗口控制台 → 正常；
//   - Electron（桌面安装）/ **GUI 子系统映像**：永远没有 → 受限子进程在 DLL 初始化阶段死，
//     `STATUS_DLL_INIT_FAILED` = 0xC0000142，**stderr 全空**。
// 空 stderr 让 seam 的 RUNNER_FAILURE_RULES（`allowedExitCodes:[127]` + `fatalSignatures:
// ["windows-acl-run: "]`）匹配不上，模型只看到裸的 `[exit code: 3221225794]`。
//
// 修法两处：
//   1. runner 在 spawn 之前确认自己持有控制台（没有就 `AllocConsole()` 并把窗口藏掉）；
//   2. 子进程若仍以 0xC0000142 退出，按 runner 失败契约报出来（签名 + exit 127），
//      从而被归类为「沙箱启动失败」而不是「命令失败」。
//
// 为什么**不要**改成「把 runner 解释器换成真 node」：桌面端这些包是从 `resources/app.asar`
// **内部**加载的，`import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')` 返回的是
// asar 内部路径，而普通 `node.exe` 读不了 asar 内部路径（实测 plain node 对该路径 ENOENT，
// 只有 Electron 的 fs shim 能读）→ runner 连启动都失败，比现状更糟。该思路只在解包安装下成立。
//
// 锚点已对 `portable/upstream.pin` = 477b4f420553e8a52c2fbccc464d7561b239c443 逐条校验（各命中 1 次）：
//   packages/sandbox/sandbox-windows-acl/src/runner.ts   sha256 542b77278d974f5f93c2a0b925468e96e52737366ed88df7d118a5af67c2eff0
//   packages/sandbox/sandbox-windows-acl/src/ffi.ts      sha256 9e90ba38afee21078bfa93c976459a131e8f50fdafd22a8fcf3a3433117b1535
// 任何一条锚点不再唯一命中都会**大声失败**，绝不静默跳过。
//
// 用法: node portable/patch-windows-acl-runner-console.mjs <repo-root>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 目标包在工作区里的目录名与包名不同（见其 package.json 的 repository.directory）。 */
const PACKAGE_DIR = 'packages/sandbox/sandbox-windows-acl'

/**
 * 一条字面量替换：`from` 必须恰好命中一次，否则视为上游漂移。
 * @typedef {{ name: string, from: string, to: string }} Edit
 */

/**
 * 逐文件的编辑集。每个文件自带幂等标记（两个文件注入的符号不同）。
 * @type {ReadonlyArray<{ file: string, marker: string, edits: ReadonlyArray<Edit> }>}
 */
const TARGETS = [
  {
    file: 'src/ffi.ts',
    marker: 'allocConsole',
    edits: [
      {
        name: 'binding table: console calls',
        from: '  setConsoleCtrlHandler(handler: null, add: number): number\n',
        to: '  setConsoleCtrlHandler(handler: null, add: number): number\n'
          + '  getConsoleWindow(): NativePtr | null\n'
          + '  allocConsole(): number\n'
          + '  showWindow(window: NativePtr, command: number): number\n',
      },
      {
        name: 'user32 loaded for ShowWindow',
        from: '  const { PVOID, PPVOID } = ffiTypes()\n'
          + '  cached = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({\n',
        to: '  const { PVOID, PPVOID } = ffiTypes()\n'
          + '  // The console calls are kernel32; only ShowWindow needs user32.\n'
          + "  const user32 = koffi.load('user32.dll')\n"
          + '  cached = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({\n',
      },
      {
        name: 'binding table: console implementations',
        from: "    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),\n",
        to: "    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),\n"
          + "    getConsoleWindow: bind(kernel32, 'GetConsoleWindow', PVOID, []),\n"
          + "    allocConsole: bind(kernel32, 'AllocConsole', 'int', []),\n"
          + "    showWindow: bind(user32, 'ShowWindow', 'int', [PVOID, 'int']),\n",
      },
    ],
  },
  {
    file: 'src/runner.ts',
    marker: 'ensureSharedConsole',
    edits: [
      {
        name: 'imports for the console probe',
        from: "import { win32 } from './ffi.ts'\n",
        to: "import { isNullPtr, win32 } from './ffi.ts'\n"
          + "import type { Win32Bindings } from './ffi.ts'\n",
      },
      {
        name: 'shared-console helper',
        from: '/** Print the runner-failure signature line and unwind. */\n'
          + 'function fail(detail: string): never {\n'
          + '  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\\n`)\n'
          + '  throw new RunnerFailure(detail)\n'
          + '}\n',
        to: '/** Print the runner-failure signature line and unwind. */\n'
          + 'function fail(detail: string): never {\n'
          + '  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\\n`)\n'
          + '  throw new RunnerFailure(detail)\n'
          + '}\n'
          + '\n'
          + '/** STATUS_DLL_INIT_FAILED: the restricted child never reached its entry point. */\n'
          + 'const STATUS_DLL_INIT_FAILED = 0xC0000142\n'
          + '/** ShowWindow command that hides the window AllocConsole just created. */\n'
          + 'const SW_HIDE = 0\n'
          + '\n'
          + '/**\n'
          + ' * Make sure this process owns the console the restricted child has to share.\n'
          + ' *\n'
          + ' * AclSandbox spawns the child with creationFlags 0, so the child attaches to\n'
          + ' * whatever console THIS process owns. A console-subsystem image owns one even\n'
          + ' * under CREATE_NO_WINDOW; a GUI-subsystem image (the packaged Electron shell)\n'
          + ' * owns none, and then every confined command dies inside DLL initialization\n'
          + ' * with STATUS_DLL_INIT_FAILED and an empty stderr, which the seam cannot\n'
          + ' * classify. Allocate one here when we have none, and hide the window it makes.\n'
          + ' * @param api - active ACL/token binding table.\n'
          + ' */\n'
          + 'function ensureSharedConsole(api: Win32Bindings): void {\n'
          + '  if (!isNullPtr(api.getConsoleWindow())) return\n'
          + '  if (api.allocConsole() === 0) {\n'
          + '    fail(`AllocConsole failed (Win32 ${api.getLastError()})`)\n'
          + '  }\n'
          + '  const window = api.getConsoleWindow()\n'
          + "  if (isNullPtr(window)) fail('AllocConsole succeeded but GetConsoleWindow is still NULL')\n"
          + '  api.showWindow(window, SW_HIDE)\n'
          + '}\n',
      },
      {
        name: 'acquire the console before registering the handler',
        from: '  const api = await win32()\n'
          + "  // Ignore this process's own CTRL+C: the confined child (same console) keeps\n",
        to: '  const api = await win32()\n'
          + '  // The child is spawned with creationFlags 0, so it shares THIS process\n'
          + "  // console; without one it dies in DLL initialization (0xC0000142, empty\n"
          + '  // stderr). Acquire it before registering the handler that owns it.\n'
          + '  ensureSharedConsole(api)\n'
          + "  // Ignore this process's own CTRL+C: the confined child (same console) keeps\n",
      },
      {
        name: '0xC0000142 is a runner failure, not a command failure',
        from: '    const result = await child.wait()\n    return result.exitCode\n',
        to: '    const result = await child.wait()\n'
          + '    if (result.exitCode === STATUS_DLL_INIT_FAILED || result.exitCode === (STATUS_DLL_INIT_FAILED | 0)) {\n'
          + "      fail('the confined child died during DLL initialization (0xC0000142 STATUS_DLL_INIT_FAILED): this runner had no console to share with it')\n"
          + '    }\n'
          + '    return result.exitCode\n',
      },
    ],
  },
]

/**
 * 对一份源码套用编辑集。
 * @param source - 当前文件内容。
 * @param edits - 该文件的编辑集。
 * @param already - 该文件是否已经打过（按 marker 判定）。
 * @param label - 报错用的位置。
 * @returns 打完的内容，或 undefined 表示无需改动。
 */
function patchSource(source, edits, already, label) {
  if (already) return undefined
  let patched = source
  for (const edit of edits) {
    const occurrences = patched.split(edit.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`${label}: ${edit.name}: expected exactly 1 occurrence, found ${occurrences} --- the source changed upstream`)
    }
    patched = patched.replace(edit.from, edit.to)
  }
  return patched
}

/**
 * CLI 入口：对上游检出就地打补丁。
 * @returns nothing; 任何断言失败都以非零退出。
 */
function main() {
  const root = process.argv[2]
  if (root === undefined) {
    console.error('用法: node portable/patch-windows-acl-runner-console.mjs <repo-root>')
    process.exit(2)
  }
  const packageDir = join(resolve(root), PACKAGE_DIR)
  if (!existsSync(packageDir)) throw new Error(`no ${PACKAGE_DIR} under ${resolve(root)}`)

  const tally = { patched: 0, already: 0 }
  for (const target of TARGETS) {
    const file = join(packageDir, target.file)
    if (!existsSync(file)) throw new Error(`${file} is missing --- the package layout changed upstream`)
    const source = readFileSync(file, 'utf8')
    const patched = patchSource(source, target.edits, source.includes(target.marker), file)
    if (patched === undefined) {
      tally.already += 1
      continue
    }
    if (!patched.includes(target.marker)) throw new Error(`${file}: patch did not take`)
    writeFileSync(file, patched)
    tally.patched += 1
    console.log(`  + ${file}`)
  }
  console.log(`patch-windows-acl-runner-console: patched=${String(tally.patched)} already=${String(tally.already)}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}
