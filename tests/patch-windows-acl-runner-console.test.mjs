// 运行: node tests/patch-windows-acl-runner-console.test.mjs
// 覆盖: 夹具改写（含「分配控制台必须早于注册 CTRL+C 处理器」的顺序）/ 幂等 / 上游漂移要报错 /
//       缺包或缺文件要报错 / 真实上游源码（若本机有检出）逐条锚点回归。
//
// 说明: 夹具里的每一段锚点都是从 upstream.pin = 477b4f4 的真实源码逐字抄下来的，
// 所以夹具命中 ⇔ 真实源码命中。真实源码那一段在检出存在时额外跑一遍（CI 里上游就在
// ../upstream/deepseek-harness），并且只对**副本**动手，绝不改检出本身。
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCHER = join(HERE, '..', 'portable', 'patch-windows-acl-runner-console.mjs')
const PACKAGE_DIR = ['packages', 'sandbox', 'sandbox-windows-acl']
const NODE = process.execPath

/** ffi.ts 夹具：绑定表接口 + user32 载入点 + SetConsoleCtrlHandler 绑定，逐字来自 477b4f4。 */
const FFI_FIXTURE = [
  "/** ACL/token bindings layered on the shared Win32 process owner. */",
  '',
  "import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'",
  '',
  'export interface Win32Bindings extends Win32ProcessBindings {',
  '  getTempPathW(length: number, buffer: Buffer): number',
  '  setEnvironmentVariableW(name: string, value: string): number',
  '  setConsoleCtrlHandler(handler: null, add: number): number',
  '  createFileW(',
  '    fileName: string,',
  '  ): NativePtr',
  '}',
  '',
  'let cached: Win32Bindings | undefined',
  '',
  'function bindings(): Win32Bindings {',
  '  if (cached !== undefined) return cached',
  '  const koffi = requireKoffi()',
  '  const { PVOID, PPVOID } = ffiTypes()',
  '  cached = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({',
  "    setEnvironmentVariableW: bind(kernel32, 'SetEnvironmentVariableW', 'int', ['str16', 'str16']),",
  "    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),",
  "    createFileW: bind(kernel32, 'CreateFileW', PVOID, [",
  "      'str16', 'uint32', 'uint32', PVOID, 'uint32', 'uint32', PVOID,",
  '    ]),',
  '  })) as Win32Bindings',
  '  return cached',
  '}',
  '',
].join('\n')

/** runner.ts 夹具：导入行、fail()、api 获取处、退出码镜像处，逐字来自 477b4f4。 */
const RUNNER_FIXTURE = [
  '/**',
  ' * The windows-acl confinement runner.',
  ' */',
  '',
  "import { win32 } from './ffi.ts'",
  "import { AclSandbox } from './index.ts'",
  '',
  "const RUNNER_SIGNATURE = 'windows-acl-run'",
  'const RUNNER_FAILURE_EXIT = 127',
  '',
  'class RunnerFailure extends Error {}',
  '',
  '/** Print the runner-failure signature line and unwind. */',
  'function fail(detail: string): never {',
  '  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\\n`)',
  '  throw new RunnerFailure(detail)',
  '}',
  '',
  'async function main(): Promise<number> {',
  '  const api = await win32()',
  "  // Ignore this process's own CTRL+C: the confined child (same console) keeps",
  '  // handling its own; the runner must survive to revoke grants and mirror the',
  "  // child's exit code.",
  '  if (api.setConsoleCtrlHandler(null, 1) === 0) {',
  "    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)",
  '  }',
  '  const sandbox = new AclSandbox({})',
  '  await sandbox.init()',
  '  try {',
  '    const child = sandbox.spawn({',
  "      command: 'x',",
  '      stdio: \'inherit\',',
  '    })',
  '    const result = await child.wait()',
  '    return result.exitCode',
  '  } finally {',
  '    sandbox.dispose()',
  '  }',
  '}',
  '',
].join('\n')

/** 按上游布局铺一套夹具。 */
function plant(root) {
  const src = join(root, ...PACKAGE_DIR, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'ffi.ts'), FFI_FIXTURE)
  writeFileSync(join(src, 'runner.ts'), RUNNER_FIXTURE)
  return src
}

function run(root) {
  return spawnSync(NODE, [PATCHER, root], { encoding: 'utf8', timeout: 120000 })
}

const roots = []
try {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acl-src-'))
  roots.push(root)
  const src = plant(root)

  // 1. 首次改写：两个文件都命中
  const first = run(root)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /patched=2 already=0/, first.stdout)
  const ffi = readFileSync(join(src, 'ffi.ts'), 'utf8')
  const runner = readFileSync(join(src, 'runner.ts'), 'utf8')

  // ffi.ts：接口 + user32 + 三个绑定
  assert.match(ffi, /getConsoleWindow\(\): NativePtr \| null/)
  assert.match(ffi, /allocConsole\(\): number/)
  assert.match(ffi, /showWindow\(window: NativePtr, command: number\): number/)
  assert.match(ffi, /const user32 = koffi\.load\('user32\.dll'\)/)
  assert.match(ffi, /getConsoleWindow: bind\(kernel32, 'GetConsoleWindow', PVOID, \[\]\)/)
  assert.match(ffi, /allocConsole: bind\(kernel32, 'AllocConsole', 'int', \[\]\)/)
  assert.match(ffi, /showWindow: bind\(user32, 'ShowWindow', 'int', \[PVOID, 'int'\]\)/)

  // runner.ts：导入、常量、helper、调用点、诊断
  assert.match(runner, /import \{ isNullPtr, win32 \} from '\.\/ffi\.ts'/)
  assert.match(runner, /import type \{ Win32Bindings \} from '\.\/ffi\.ts'/)
  assert.match(runner, /const STATUS_DLL_INIT_FAILED = 0xC0000142/)
  assert.match(runner, /const SW_HIDE = 0/)
  assert.match(runner, /function ensureSharedConsole\(api: Win32Bindings\): void \{/)
  assert.match(runner, /if \(!isNullPtr\(api\.getConsoleWindow\(\)\)\) return/)
  assert.match(runner, /api\.showWindow\(window, SW_HIDE\)/)
  assert.match(runner, /ensureSharedConsole\(api\)/)
  assert.match(runner, /result\.exitCode === STATUS_DLL_INIT_FAILED/)
  // 顺序：必须先把控制台拿到手，再注册「同控制台」的 CTRL+C 处理器
  assert.ok(
    runner.indexOf('ensureSharedConsole(api)') < runner.indexOf('api.setConsoleCtrlHandler(null, 1)'),
    'the console must be acquired BEFORE the CTRL+C handler that owns it',
  )
  // 原始锚点必须已被替换
  assert.doesNotMatch(runner, /^import \{ win32 \} from '\.\/ffi\.ts'$/mu)
  assert.doesNotMatch(runner, /^  setConsoleCtrlHandler\(handler: null, add: number\): number$/mu)

  // 2. 幂等
  const second = run(root)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /patched=0 already=2/, second.stdout)

  // 3. 上游漂移要报错（改掉 ffi.ts 的一条锚点）
  const drifted = mkdtempSync(join(tmpdir(), 'dsh-acl-src-drift-'))
  roots.push(drifted)
  const driftedSrc = plant(drifted)
  writeFileSync(
    join(driftedSrc, 'ffi.ts'),
    readFileSync(join(driftedSrc, 'ffi.ts'), 'utf8')
      .replace("setConsoleCtrlHandler(handler: null, add: number): number", 'setConsoleCtrlHandler(handler: null, add: int): number'),
  )
  const third = run(drifted)
  assert.notEqual(third.status, 0, 'a moved binding surface must fail loudly')
  assert.match(third.stderr, /source changed upstream/)

  // 4. 缺包要报错
  const empty = mkdtempSync(join(tmpdir(), 'dsh-acl-src-empty-'))
  roots.push(empty)
  const fourth = run(empty)
  assert.notEqual(fourth.status, 0, 'a tree without the package must fail loudly')
  assert.match(fourth.stderr, /no packages\/sandbox\/sandbox-windows-acl/)

  // 5. 缺文件要报错
  const partial = mkdtempSync(join(tmpdir(), 'dsh-acl-src-partial-'))
  roots.push(partial)
  const partialSrc = plant(partial)
  rmSync(join(partialSrc, 'runner.ts'))
  const fifth = run(partial)
  assert.notEqual(fifth.status, 0, 'a missing source file must fail loudly')
  assert.match(fifth.stderr, /is missing/)

  // 6. 真实上游源码回归（检出存在时才跑；只动副本）
  const checkouts = [
    process.env.DSH_DESKTOP_SOURCE,
    join(HERE, '..', 'upstream', 'deepseek-harness'),
  ].filter((path) => path !== undefined && existsSync(join(path, ...PACKAGE_DIR, 'src', 'runner.ts')))
  if (checkouts.length === 0) {
    console.log('skip: no upstream checkout with the package sources; set DSH_DESKTOP_SOURCE to run this half')
  } else {
    for (const checkout of checkouts) {
      const copy = mkdtempSync(join(tmpdir(), 'dsh-acl-src-real-'))
      roots.push(copy)
      cpSync(join(checkout, ...PACKAGE_DIR), join(copy, ...PACKAGE_DIR), { recursive: true })
      const real = run(copy)
      assert.equal(real.status, 0, `${String(checkout)}: ${real.stderr}`)
      assert.match(real.stdout, /patched=2 already=0/, String(checkout))
      // 副本上再跑一次必须幂等
      assert.match(run(copy).stdout, /patched=0 already=2/, String(checkout))
      console.log(`real source ok: ${String(checkout)}`)
    }
  }

  console.log('patch-windows-acl-runner-console.test: ok')
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
