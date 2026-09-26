// dsh 桌面端（Electron）绿色便携流水线 —— 与 portable/ 便携版同源、同一 release。
//
// 产物 dsh-desktop-win64-<short>.zip：整棵 Electron 目录 + 便携引导 + 更新清单（便携版则出
// app/ + node/ + dsh.exe + update.exe）。
// 步骤顺序别调换：源码补丁 → 构建 → P1 打在**已构建的 lib** → 迁移器 → 打包（禁止内部重建）
// → 组装绿色包 → 压缩 + 自验收。上游打包流程内部会重跑 build:official 覆盖 P1，故必须带
// DSH_DESKTOP_SKIP_INTERNAL_BUILD=1。
//
// 环境变量：DSH_DESKTOP_SOURCE / TAG / OUT / ZIP / UPDATE_EXE，
//           DSH_DESKTOP_RUN_PACKAGED_SMOKE=1 跑上游「打包后冒烟」（深目录会因 MAX_PATH 失败），
//           DSH_DESKTOP_EXTRA_PATH / DSH_DESKTOP_TEMP_DIR 本机调试用。
// 开关：--skip-build / --skip-package / --no-verify
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SOURCE = resolve(process.env.DSH_DESKTOP_SOURCE ?? join(REPO, 'upstream', 'deepseek-harness'))
const OUT_ROOT = resolve(process.env.DSH_DESKTOP_OUT ?? join(REPO, 'desktop-build'))
const STAGE = join(OUT_ROOT, 'dsh-desktop')
const PRODUCT_EXE = 'DeepSeek Harness.exe'
const TAG = (process.env.DSH_DESKTOP_TAG ?? '').trim()
const SHORT = TAG.slice(0, 7)
const ZIP = resolve(process.env.DSH_DESKTOP_ZIP ?? join(REPO, 'dsh-desktop-win64-' + (SHORT === '' ? 'unknown' : SHORT) + '.zip'))

/** tar 的解析：本机需绝对路径（PATH 里没有 System32），CI 里 PATH 就有。 */
function resolveTar() {
  if (process.env.DSH_DESKTOP_TAR !== undefined) return process.env.DSH_DESKTOP_TAR
  const systemTar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
  return existsSync(systemTar) ? systemTar : 'tar'
}

/** 子进程环境：CI 不需要任何额外设置，本机可用两个环境变量补 PATH/临时目录。 */
function childEnvironment() {
  const env = { ...process.env, CI: process.env.CI ?? 'true' }
  if (process.env.DSH_DESKTOP_EXTRA_PATH !== undefined) {
    env.PATH = process.env.DSH_DESKTOP_EXTRA_PATH + ';' + (process.env.PATH ?? '')
  }
  if (process.env.DSH_DESKTOP_TEMP_DIR !== undefined) {
    env.TMP = process.env.DSH_DESKTOP_TEMP_DIR
    env.TEMP = process.env.DSH_DESKTOP_TEMP_DIR
    env.TMPDIR = process.env.DSH_DESKTOP_TEMP_DIR
  }
  return env
}

function log(step, message) { console.log('[' + step + '] ' + message) }

/** pnpm 的调用方式：CI 上没有 pnpm.exe/.cmd 的扩展名解析，必须经 shell（或直接用 JS 入口）。 */
function pnpmInvocation(args) {
  const entry = process.env.DSH_DESKTOP_PNPM ?? process.env.npm_execpath
  if (entry !== undefined && entry !== '' && /\.[cm]?js$/iu.test(entry)) {
    return { command: process.execPath, args: [entry, ...args], shell: false }
  }
  // Windows 上 pnpm 通常只是 pnpm.cmd/.ps1 包装脚本，spawn 不做扩展名解析 → 交给 shell。
  return { command: 'pnpm', args, shell: true }
}

function run(step, command, args, options) {
  const settings = options ?? {}
  log(step, '$ ' + command + ' ' + args.join(' '))
  const result = spawnSync(command, args, {
    cwd: settings.cwd ?? SOURCE,
    stdio: 'inherit',
    shell: settings.shell ?? false,
    env: { ...childEnvironment(), ...(settings.env ?? {}) },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(step + ': ' + command + ' exited with ' + String(result.status ?? result.signal))
}

/** 上游要求发布设置只来自 apps/desktop/.env.windows；我们只需要 app id + 策略校验占位值。 */
function writePackageEnvironment() {
  const path = join(SOURCE, 'apps', 'desktop', '.env.windows')
  if (existsSync(path)) return
  writeFileSync(path, [
    '# DSH-build 自建桌面端（unsigned + 绿色便携）。发布设置只从本文件读取。',
    '# 策略变量仅用于构建期校验；产物 manifest 的策略字段被 patch-desktop-update.mjs 置为 undefined，',
    '# 运行时读不到策略、也不会请求 Platform；unsigned 构建的 electron-updater publish 亦为 null（无 feed）。',
    'DSH_DESKTOP_APP_ID=com.dshbuild.desktop',
    'DSH_DESKTOP_AUTO_UPDATE_ENV=test',
    'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://download.deepseek.com',
    'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN=https://download.deepseek.com',
    'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG={"allowedAuthOrigins":["https://download.deepseek.com"]}',
    'DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY=4',
    '',
  ].join('\n'))
}

/** 找出 electron-builder 产出的 win-unpacked 目录（必须唯一）。 */
function findUnpacked() {
  const base = join(SOURCE, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === 'win-unpacked') { found.push(path); continue }
      walk(path, depth + 1)
    }
  }
  walk(base, 0)
  if (found.length === 0) throw new Error('assemble: win-unpacked not found under apps/desktop/.desktop-build/targets/win-x64')
  if (found.length > 1) throw new Error('assemble: multiple win-unpacked directories: ' + found.join(', '))
  return found[0]
}

function main() {
  const argv = process.argv.slice(2)
  const has = (flag) => argv.includes(flag)
  if (TAG === '') {
    console.error('缺少 DSH_DESKTOP_TAG（= 上游 sha，写进产物 VERSION 供更新器比对）')
    process.exit(2)
  }

  writePackageEnvironment()
  log('1/7', 'applying source patches (update disable / portable bootstrap / toolchain / runtime order)')
  run('patch', process.execPath, [join(HERE, 'patch-desktop-update.mjs'), SOURCE])
  run('patch', process.execPath, [join(HERE, 'patch-desktop-portable.mjs'), SOURCE])
  run('patch', process.execPath, [join(HERE, 'patch-desktop-toolchain.mjs'), SOURCE])
  run('patch', process.execPath, [join(HERE, 'patch-desktop-runtime-patch.mjs'), SOURCE])

  if (!has('--skip-build')) {
    log('2/7', 'building upstream repository (official profile)')
    const build = pnpmInvocation(['run', 'build:official'])
    run('build', build.command, build.args, { shell: build.shell })
  } else log('2/7', 'build skipped')

  // P1 必须写在运行时段打包成 tarball 之前，且必须在构建之后。
  log('3/7', 'P1: patching built lib files (native-code guard + v2->v3 whitelist)')
  run('P1', process.execPath, [join(HERE, 'patch-native-code.mjs'), SOURCE])
  // P1 会改动个别客户端产物（如 packages/api/session-controller/lib/client.js），
  // 而客户端构建记录是 build:official 结束时算的；在其后重算，release:pack 的摘要校验才看得到真实产物。
  log('3b/7', 'refreshing the client build record after P1')
  run('record', process.execPath, ['--import', 'tsx/esm', 'scripts/dsh-build-refresh-client-record.ts'], { env: { DSH_BUILD_CLIENT_PROFILE: 'official' } })

  if (!has('--skip-package')) {
    log('4/7 + 5/7', 'building session migrator and packaging win-x64 (unsigned, dir)')
    mkdirSync(OUT_ROOT, { recursive: true })
    run('migrator', process.execPath, [join(HERE, 'build-migrator.mjs'), SOURCE, join(OUT_ROOT, 'migrate-sessions-v4.mjs')])
    const packageEnv = {
      // 我们只出解包目录：安装器工具链预检与 NSIS 安装器 UI 准备都不需要（本机也没有 VS）。
      DSH_DESKTOP_SKIP_INSTALLER_TOOLCHAIN: '1',
      // P1 已打在当前 lib 上，禁止打包流程内部重建把它们覆盖掉。
      DSH_DESKTOP_SKIP_INTERNAL_BUILD: '1',
    }
    if (process.env.DSH_DESKTOP_RUN_PACKAGED_SMOKE !== '1') packageEnv.DSH_DESKTOP_SKIP_PACKAGED_SMOKE = '1'
    const pack = pnpmInvocation(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'package:win:x64:unsigned', '--', '--dir'])
    run('package', pack.command, pack.args, { shell: pack.shell, env: packageEnv })
  } else log('4/7 + 5/7', 'packaging skipped')

  log('6/7', 'assembling the green package')
  const unpacked = findUnpacked()
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })
  cpSync(unpacked, STAGE, { recursive: true })
  if (!existsSync(join(STAGE, PRODUCT_EXE))) throw new Error('assemble: ' + PRODUCT_EXE + ' missing from ' + unpacked)
  writeFileSync(join(STAGE, 'portable.flag'), 'DSH-build portable desktop package\n')
  writeFileSync(join(STAGE, 'VERSION'), TAG + '\n')
  writeFileSync(join(STAGE, 'update.json'), JSON.stringify({
    kind: 'desktop',
    repo: 'citydirector/DSH-build',
    channelTags: { main: 'dsh-master-latest', dev: 'dsh-dev-latest' },
    assetPrefix: 'dsh-desktop-win64',
    versionFile: 'VERSION',
    mirror: '.',
    preserve: ['data'],
    processNames: [PRODUCT_EXE.replace(/\.exe$/u, '')],
    expectEntry: PRODUCT_EXE,
    zipName: 'dsh-desktop.zip',
  }, undefined, 2) + '\n')
  const migratorTarget = join(STAGE, 'resources', 'dsh-build')
  mkdirSync(migratorTarget, { recursive: true })
  const builtMigrator = join(OUT_ROOT, 'migrate-sessions-v4.mjs')
  if (existsSync(builtMigrator)) cpSync(builtMigrator, join(migratorTarget, 'migrate-sessions-v4.mjs'))
  else log('assemble', 'WARN migrator missing; the portable bootstrap will skip session migration')
  const updateExe = resolve(process.env.DSH_DESKTOP_UPDATE_EXE ?? join(HERE, 'update.exe'))
  if (existsSync(updateExe)) cpSync(updateExe, join(STAGE, 'update.exe'))
  else log('assemble', 'WARN update.exe missing; the package ships without the manifest-aware updater')
  log('data', 'ships no data/ (DSH_HOME is created by the app on first run)')

  log('7/7', 'archiving')
  rmSync(ZIP, { force: true })
  run('zip', resolveTar(), ['-a', '-c', '-f', ZIP, '-C', STAGE, '.'], { cwd: STAGE })
  const bytes = statSync(ZIP).size
  console.log('done: ' + ZIP + ' (' + (bytes / 1048576).toFixed(1) + ' MB)')
  console.log('      package: ' + STAGE)

  if (!has('--no-verify')) {
    log('verify', 'running static acceptance checks')
    run('verify', process.execPath, [join(HERE, 'verify-desktop.mjs'), '--dir', STAGE])
  }
}

main()
