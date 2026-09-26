// 两个桌面补丁脚本的回归测试：fixture 树 + 幂等 + 锚点缺失必须报错。
// 运行: node --test tests/patch-desktop.test.mjs  （或 node tests/patch-desktop.test.mjs）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchDesktopUpdate, isPatched as updatePatched, EDITS } from '../portable/patch-desktop-update.mjs'
import { patchDesktopPortable } from '../portable/patch-desktop-portable.mjs'
import { patchDesktopToolchain, EDITS as TOOLCHAIN_EDITS } from '../portable/patch-desktop-toolchain.mjs'
import { patchDesktopComputerUse, RUNTIME_PACKAGES } from '../portable/patch-desktop-computer-use.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const files = resolve(HERE, '..', 'portable', 'desktop-files')

/** 造一棵只含被补丁文件的假源码树。 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-patch-'))
  const write = (rel, text) => {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  write('apps/desktop/scripts/desktop-package-environment.mjs',
    'export function validateDesktopPackageEnvironment(environment, target, options = {}) {\n'
    + '  resolveDesktopAppId(environment)\n'
    + '  resolveNpmRegistry(environment)\n'
    + '  resolveDesktopPolicyEnvironment(environment)\n'
    + "  if (target.platform === 'darwin') resolveMacOSPackageSettings(environment)\n")
  write('apps/desktop/scripts/electron-builder-config.mjs',
    '  const appId = resolveDesktopAppId(env)\n'
    + '  const policy = resolveDesktopPolicyEnvironment(env)\n'
    + '  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM\n')
  write('apps/desktop/src/update-coordinator.ts',
    'export class DesktopUpdateCoordinator {\n'
    + '  async check(manual = false): Promise<DesktopUpdateState> {\n'
    + '    this.assertLive()\n'
    + '    if (this.downloadOperation !== undefined) return this.current\n')
  write('apps/desktop/src/main.ts', "import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'\n\nconst x = 1\n")
  write('apps/desktop/scripts/package-target.ts',
    'export async function packageTarget(invocation, targetEnv) {\n'
    + "    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', ...(invocation.unsigned ? ['--unsigned'] : [])], targetEnv)\n"
    + '}\n')
  write('apps/desktop/scripts/desktop-toolchain-preflight.ts',
    'export async function probeDesktopToolchain(platform, environment = process.env) {\n'
    + '  const failures = []\n'
    + "  if (platform === 'win32') failures.push(...await probeWindowsInstallerToolchain(environment))\n"
    + '  return failures\n'
    + '}\n')
  return root
}

function patchElectronBuilderEmbed(root) {
  // EDITS 里 manifest 字段的替换依赖同一文件里的 policy 变量；这里补上字段行以覆盖 4 处编辑。
  const path = join(root, 'apps/desktop/scripts/electron-builder-config.mjs')
  writeFileSync(path, readFileSync(path, 'utf8')
    + "    extraMetadata: {\n      dshDesktopAppId: appId,\n      dshMandatoryUpdatePolicy: policy,\n"
    + "    beforeBuild: async () => {\n      if (resolvedPlatform !== 'win32') return true\n"
    + "      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',\n"
    + "        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),\n"
    + "        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {\n"
    + "        env: scrubWindowsSigningEnvironment(env), windowsHide: true,\n"
    + "      })\n      return true\n    },\n"
    + "    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', ...(invocation.unsigned ? ['--unsigned'] : [])], targetEnv)\n")
}

const tests = []
function test(name, fn) { tests.push([name, fn]) }

test('P3 编辑命中且不动其它', () => {
  const root = makeTree()
  try {
    patchElectronBuilderEmbed(root)
    const { applied } = patchDesktopUpdate(root)
    assert.equal(applied.length, EDITS.length)
    const builder = readFileSync(join(root, 'apps/desktop/scripts/electron-builder-config.mjs'), 'utf8')
    assert.ok(builder.includes('dshMandatoryUpdatePolicy: undefined,'))
    const pkgEnv = readFileSync(join(root, 'apps/desktop/scripts/desktop-package-environment.mjs'), 'utf8')
    assert.ok(pkgEnv.includes('resolveDesktopPolicyEnvironment(environment)'))
    assert.ok(updatePatched(root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P3 锚点缺失时报错而不是静默跳过', () => {
  const root = makeTree()
  try {
    patchElectronBuilderEmbed(root)
    writeFileSync(join(root, 'apps/desktop/scripts/electron-builder-config.mjs'), 'export const x = 1\n')
    assert.throws(() => patchDesktopUpdate(root), /expected exactly 1 occurrence/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P3 不动运行时（update-coordinator 原样保留）', () => {
  const root = makeTree()
  try {
    patchElectronBuilderEmbed(root)
    const before = readFileSync(join(root, 'apps/desktop/src/update-coordinator.ts'), 'utf8')
    patchDesktopUpdate(root)
    assert.equal(readFileSync(join(root, 'apps/desktop/src/update-coordinator.ts'), 'utf8'), before)
    assert.ok(!before.includes('never consult electron-updater'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P3 幂等：重复运行不重复改（第二次因已改而抛锚点不匹配）', () => {
  const root = makeTree()
  try {
    patchElectronBuilderEmbed(root)
    patchDesktopUpdate(root)
    assert.throws(() => patchDesktopUpdate(root), /expected exactly 1 occurrence/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P2 写入 bootstrap 并把 import 插到第一行', () => {
  const root = makeTree()
  try {
    const result = patchDesktopPortable(root)
    assert.deepEqual(result.added, ['apps/desktop/src/dsh-portable-bootstrap.ts'])
    assert.equal(result.insertedImport, true)
    const main = readFileSync(join(root, 'apps/desktop/src/main.ts'), 'utf8')
    assert.equal(main.split('\n')[0], "import './dsh-portable-bootstrap.ts'")
    assert.equal(readFileSync(join(root, 'apps/desktop/src/dsh-portable-bootstrap.ts'), 'utf8'),
      readFileSync(join(files, 'dsh-portable-bootstrap.ts'), 'utf8'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P2 幂等：第二次运行不再插入 import', () => {
  const root = makeTree()
  try {
    patchDesktopPortable(root)
    const second = patchDesktopPortable(root)
    assert.equal(second.insertedImport, false)
    assert.deepEqual(second.added, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('工具链补丁：两处编辑都能命中且幂等', () => {
  const root = makeTree()
  try {
    patchElectronBuilderEmbed(root)
    const first = patchDesktopToolchain(root)
    assert.equal(first.applied.length, TOOLCHAIN_EDITS.length)
    const second = patchDesktopToolchain(root)
    assert.deepEqual(second.applied, [])
    const preflight = readFileSync(join(root, 'apps/desktop/scripts/desktop-toolchain-preflight.ts'), 'utf8')
    assert.ok(preflight.includes('DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN'))
    const builder = readFileSync(join(root, 'apps/desktop/scripts/electron-builder-config.mjs'), 'utf8')
    assert.ok(builder.includes('prepare-windows-installer.ps1'))
    assert.ok(builder.includes("env.DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN !== '1'"))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('computer-use 补丁：声明注册表 + 提供方 + 平台原生包、幂等、缺件必须报错', () => {
  // 平台原生的**真实**命名带工具链后缀（win32-x64-msvc / linux-x64-gnu / darwin-arm64）——
  // 早先按 endsWith('<platform>-<arch>') 匹配，全被 -msvc 顶掉；这条就是那个回归。
  const NATIVE_SUFFIX = {
    win32: { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
    linux: { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu' },
    darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
  }
  const host = NATIVE_SUFFIX[process.platform]?.[process.arch] ?? `${process.platform}-${process.arch}`
  const foreign = process.platform === 'win32' ? 'linux-x64-gnu' : 'win32-x64-msvc'
  const sdkNative = `@trycua/cua-driver-${host}`
  const ubjsNative = `@ubjs/node-${host}`

  /** 造一棵含「提供方 → SDK → ubjs」解析链的假树。 */
  const makeTree = () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-'))
    const write = (rel, value) => {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
    }
    write('apps/desktop/package.json', {
      name: '@deepseek-ai/dsh-desktop',
      version: '0.0.0',
      dependencies: { '@deepseek-ai/dsh-base': 'workspace:*' },
    })
    const provider = 'packages/experimental/computer-use-cua-driver-native'
    write(`${provider}/package.json`, { name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', version: '0.0.0' })
    // SDK 的形状照真实：平台原生包在 optionalDependencies（electron-builder 不收 —— 坑一），
    // exports 只给 import 条件、不暴露 ./package.json（require 读清单会失败 —— 坑二、三）
    write(`${provider}/node_modules/@trycua/cua-driver/package.json`, {
      name: '@trycua/cua-driver',
      version: '0.28.0',
      main: 'index.js',
      exports: { '.': { import: './index.js' } },
      optionalDependencies: { [sdkNative]: '0.28.0', [`@trycua/cua-driver-${foreign}`]: '0.28.0' },
    })
    writeFileSync(join(root, provider, 'node_modules/@trycua/cua-driver/index.js'), 'export default {}\n')
    write(`${provider}/node_modules/@trycua/cua-driver/node_modules/@ubjs/node/package.json`, {
      name: '@ubjs/node',
      version: '0.31.0-3',
      main: 'index.js',
      exports: { '.': './index.js' },
      optionalDependencies: { [ubjsNative]: '0.31.0-3', [`@ubjs/node-${foreign}`]: '0.31.0-3' },
    })
    writeFileSync(join(root, provider, 'node_modules/@trycua/cua-driver/node_modules/@ubjs/node/index.js'), 'module.exports = {}\n')
    return root
  }

  const root = makeTree()
  const manifestPath = join(root, 'apps/desktop/package.json')
  try {
    const first = patchDesktopComputerUse(root)
    assert.deepEqual([...first.added].sort(), [...RUNTIME_PACKAGES, sdkNative, ubjsNative].sort())
    const written = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const name of RUNTIME_PACKAGES) assert.equal(written.dependencies[name], 'workspace:*')
    assert.equal(written.dependencies[sdkNative], '0.28.0', '平台原生包按已安装清单的精确版本声明')
    assert.equal(written.dependencies[ubjsNative], '0.31.0-3')
    assert.equal(written.dependencies['@deepseek-ai/dsh-base'], 'workspace:*', '不能动原有依赖')
    assert.ok(!(`@trycua/cua-driver-${foreign}` in written.dependencies), '不声明别的平台')
    assert.ok(!(`@ubjs/node-${foreign}` in written.dependencies), 'ubjs 也不声明别的平台')
    assert.deepEqual(patchDesktopComputerUse(root).added, [], '第二次必须无改动（幂等）')
    // 上游改了结构时必须报错，而不是静默加不上、最后打出一个没有原生二进制的包
    writeFileSync(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh-desktop' }, null, 2) + '\n')
    assert.throws(() => patchDesktopComputerUse(root), /dependencies/)
  } finally { rmSync(root, { recursive: true, force: true }) }

  // 构建树里没装 SDK 也必须报错。用**新树**：require 会缓存上一次成功加载的 JSON，
  // 在同一个树里删掉文件再测会被缓存骗过去（构建里只跑一次，故不影响生产）。
  const missing = makeTree()
  try {
    rmSync(join(missing, 'packages/experimental/computer-use-cua-driver-native/node_modules'), { recursive: true, force: true })
    assert.throws(() => patchDesktopComputerUse(missing), /@trycua\/cua-driver/)
  } finally { rmSync(missing, { recursive: true, force: true }) }
})

test('computer-use 补丁：pnpm isolated 布局（包与依赖并排 + 链接）也能找齐', () => {
  const HOST = {
    win32: { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc' },
    linux: { x64: 'linux-x64-gnu', arm64: 'linux-arm64-gnu' },
    darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
  }[process.platform]?.[process.arch] ?? `${process.platform}-${process.arch}`
  const sdkNative = `@trycua/cua-driver-${HOST}`
  const ubjsNative = `@ubjs/node-${HOST}`

  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-store-'))
  const write = (rel, value) => {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  }
  try {
    write('apps/desktop/package.json', {
      name: '@deepseek-ai/dsh-desktop',
      dependencies: { '@deepseek-ai/dsh-base': 'workspace:*' },
    })
    const provider = 'packages/experimental/computer-use-cua-driver-native'
    write(`${provider}/package.json`, { name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', version: '0.0.0' })
    // pnpm 的真实形状：SDK 与它的依赖（ubjs）**并排**躺在同一个 store 目录的 node_modules 下，
    // 而 provider 通过链接引用 SDK。不 realpath、不在 node_modules 这一级特殊处理，ubjs 就找不到。
    const store = 'node_modules/.pnpm/@trycua+cua-driver@0.28.0/node_modules'
    write(`${store}/@trycua/cua-driver/package.json`, {
      name: '@trycua/cua-driver',
      version: '0.28.0',
      exports: { '.': { import: './index.js' } },
      optionalDependencies: { [sdkNative]: '0.28.0' },
    })
    writeFileSync(join(root, store, '@trycua/cua-driver/index.js'), 'export default {}\n')
    write(`${store}/@ubjs/node/package.json`, {
      name: '@ubjs/node',
      version: '0.31.0-3',
      optionalDependencies: { [ubjsNative]: '0.31.0-3' },
    })
    mkdirSync(join(root, provider, 'node_modules/@trycua'), { recursive: true })
    symlinkSync(join(root, store, '@trycua/cua-driver'), join(root, provider, 'node_modules/@trycua/cua-driver'),
      process.platform === 'win32' ? 'junction' : 'dir')

    const { added } = patchDesktopComputerUse(root)
    assert.ok(added.includes(sdkNative), 'SDK 平台原生包应被声明：' + added.join(', '))
    assert.ok(added.includes(ubjsNative), 'ubjs 平台原生包应被声明：' + added.join(', '))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log('  ok  ' + name) }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error instanceof Error ? error.stack : String(error))) }
}
console.log(`patch-desktop tests: ${tests.length - failed}/${tests.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
