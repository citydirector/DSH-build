// 两个桌面补丁脚本的回归测试：fixture 树 + 幂等 + 锚点缺失必须报错。
// 运行: node --test tests/patch-desktop.test.mjs  （或 node tests/patch-desktop.test.mjs）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchDesktopUpdate, isPatched as updatePatched, EDITS } from '../portable/patch-desktop-update.mjs'
import { patchDesktopPortable } from '../portable/patch-desktop-portable.mjs'
import { patchDesktopToolchain, EDITS as TOOLCHAIN_EDITS } from '../portable/patch-desktop-toolchain.mjs'

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

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log('  ok  ' + name) }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error instanceof Error ? error.stack : String(error))) }
}
console.log(`patch-desktop tests: ${tests.length - failed}/${tests.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
