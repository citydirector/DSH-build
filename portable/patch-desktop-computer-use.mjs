// patch-desktop-computer-use.mjs <upstream-repo-root>
//
// 让官方 computer-use 在桌面端可用。做三件事，幂等：
//
//   1. 声明依赖：把注册表（@deepseek-ai/dsh-computer-use）、原生提供方
//      （@deepseek-ai/dsh-experimental-computer-use-cua-driver-native）以及 SDK / ubjs 的平台原生包
//      写进三份清单 —— apps/desktop-host（产出运行时树 dsh/）、apps/desktop（asar 根）、
//      @deepseek-ai/dsh 本体（加载器按它的 dependencies ∪ peerDependencies 决定哪些包能被
//      profile 的插件行解析，缺一不可）。版本取自构建树里已安装的清单，上游升级自动跟随。
//   2. 解包：给 electron-builder 的 asarUnpack 补上 @trycua/** 与 @ubjs/**。
//   3. 原生库路径映射：改 @ubjs/node 的 resolveLibPath，见 patchUbjsLibPath 的说明。
//
// 两处上游结构若变动会直接抛错（锚点缺失），宁可构建失败也不静默出一个装不上原生运行时的包。
// 用法: node patch-desktop-computer-use.mjs <repo-root>
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'

import { basename, dirname, join, relative } from 'node:path'

/** 依赖要声明进的三份清单（见文件头第 1 条）。 */
const MANIFESTS = [
  'apps/desktop-host/package.json',
  'apps/desktop/package.json',
]
/** 原生提供方所在 workspace 目录（pnpm 把它的依赖链接在它自己的 node_modules 下）。 */
const PROVIDER_DIR = 'packages/experimental/computer-use-cua-driver-native'
/** 上游 Builder 配置（asarUnpack 数组在里面）。 */
const BUILDER_CONFIG = 'apps/desktop/scripts/electron-builder-config.mjs'
/** asarUnpack 数组的首行 —— 插入锚点。 */
const UNPACK_ANCHOR = "  const unpack = ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg',"
/** 要补进去的解包模式：@ubjs 必须解出来（打包后要在那份真实文件上补原生库路径映射）；
 *  @trycua 一并解出，让 SDK 的 JS 与清单也落在真实路径上。原生的 .dll/.node 由上游按文件类型解包。 */
const UNPACK_PATTERNS = "    '**/@trycua/**', '**/@ubjs/**',"
/** 构建平台后缀（win32-x64 / darwin-arm64 …）。 */
const PLATFORM_SUFFIX = `${process.platform}-${process.arch}`

/** 必须出现在产物里的两个插件包：注册表在前（提供方 inject 它提供的服务）。 */
export const RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-computer-use',
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
]

/** 在 workspace 里按包名找它的 package.json（返回相对 repo 根的斜杠路径）。 */
function findWorkspacePackage(root, name) {
  const manifests = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path, depth + 1)
      } else if (entry.name === 'package.json') manifests.push(path)
    }
  }
  for (const top of ['packages', 'apps', 'tools']) {
    const base = join(root, top)
    if (existsSync(base)) walk(base, 0)
  }
  const rootManifest = join(root, 'package.json')
  if (existsSync(rootManifest)) manifests.push(rootManifest)
  for (const path of manifests) {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).name === name) return relative(root, path).split('\\').join('/')
    } catch { /* 读不动的忽略 */ }
  }
  return undefined
}

/** 逐级向上找 `<dir>/node_modules/<name>`：走 node_modules 链但绕开 exports（有些包不暴露
 *  ./package.json，有些是 ESM-only），且当某一级目录本身就叫 node_modules 时直接在其下找 ——
 *  pnpm 的 isolated 布局里"包与它的依赖并排"正是这个形状。命中后做 realpath：pnpm 的链接要
 *  还原到 store 的真实位置，否则从链接出发找不到它的兄弟依赖。 */
function findPackage(startDir, name) {
  let dir = startDir
  for (let depth = 0; depth < 16; depth += 1) {
    const base = basename(dir) === 'node_modules' ? dir : join(dir, 'node_modules')
    const packageDir = join(base, name)
    if (existsSync(join(packageDir, 'package.json'))) {
      const real = realpathSync(packageDir)
      return { dir: real, manifest: JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 取包清单；找不到就抛错（调用方补现场信息）。 */
function manifestOf(startDir, name) {
  const found = findPackage(startDir, name)
  if (found === undefined) throw new Error(`patch-desktop-computer-use: 在 ${startDir} 往上的 node_modules 里找不到 ${name}`)
  return found
}

/** 平台词表：名字里命中本平台与本架构的别名、且不含任何别的平台/架构词，才算平台原生包。
 *  真实命名带工具链后缀（win32-x64-msvc / linux-x64-gnu / darwin-arm64）。 */
const PLATFORM_TOKENS = { win32: ['win32', 'windows'], darwin: ['darwin', 'macos'], linux: ['linux'] }
const ARCH_TOKENS = { x64: ['x64', 'amd64'], arm64: ['arm64', 'aarch64'] }

/** 该包名是否属于本平台的原生包（供 verify 复用同一套词表）。 */
export function matchesPlatformName(name) {
  const lower = name.toLowerCase()
  const groups = [PLATFORM_TOKENS, ARCH_TOKENS]
  const current = [process.platform, process.arch]
  for (let index = 0; index < groups.length; index += 1) {
    const table = groups[index]
    const key = current[index]
    const tokens = table[key] ?? [key]
    if (!tokens.some((token) => lower.includes(token))) return false
    for (const [otherKey, otherTokens] of Object.entries(table)) {
      if (otherKey === key) continue
      if (otherTokens.some((token) => lower.includes(token))) return false
    }
  }
  return true
}

/** 取某个包声明的平台原生依赖（dependencies 与 optionalDependencies 都看）。
 *  @param {string} startDir - 从这个目录开始向上找包。
 *  @param {string} name - 包名。
 *  @param {Record<string, string[]>} [seen] - 诊断用：记录每个包声明过的依赖名。 */
function platformNatives(startDir, name, seen) {
  const found = manifestOf(startDir, name)
  const declared = { ...found.manifest.dependencies, ...found.manifest.optionalDependencies }
  const picked = {}
  for (const [dep, version] of Object.entries(declared)) {
    if (matchesPlatformName(dep)) picked[dep] = version
  }
  if (seen !== undefined) seen[name] = Object.keys(declared)
  return { dir: found.dir, version: found.manifest.version, natives: picked }
}

/** 把两个插件包与它们的平台原生包写进三份清单（幂等）。
 *  @param {string} root - upstream 仓库根目录。
 *  @returns {{ added: Record<string, string[]>, unpacked: {changed: boolean}, libPath: {patched: string[]} }} */
export function patchDesktopComputerUse(root) {
  const providerDir = join(root, PROVIDER_DIR)
  if (!existsSync(join(providerDir, 'package.json'))) {
    throw new Error(`patch-desktop-computer-use: 找不到提供方目录 ${PROVIDER_DIR}，上游挪了位置？`)
  }

  const wanted = Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, 'workspace:*']))
  const declaredSeen = {}
  let sdk
  try {
    sdk = platformNatives(providerDir, '@trycua/cua-driver', declaredSeen)
  } catch (error) {
    const hints = [
      `provider/node_modules=${existsSync(join(providerDir, 'node_modules'))}`,
      `root/node_modules/@trycua=${existsSync(join(root, 'node_modules', '@trycua'))}`,
      `root/node_modules/.pnpm=${existsSync(join(root, 'node_modules', '.pnpm'))}`,
    ].join(' ')
    throw new Error(`${error instanceof Error ? error.message : String(error)} [${hints}]`, { cause: error })
  }
  if (!Object.keys(sdk.natives).some((name) => name.startsWith('@trycua/cua-driver-'))) {
    throw new Error(`patch-desktop-computer-use: @trycua/cua-driver@${sdk.version} 里找不到 ${PLATFORM_SUFFIX} 平台的包（它声明的依赖：${(declaredSeen['@trycua/cua-driver'] ?? []).join(', ')}）`)
  }
  Object.assign(wanted, sdk.natives)

  // ubjs 的平台原生（@ubjs/node-<suffix>）挂在 SDK 的依赖树下，必须找到：缺了它原生跑不起来。
  const ubjsNatives = {}
  const ubjsSeen = {}
  for (const name of ['@ubjs/core', '@ubjs/node']) {
    for (const base of [sdk.dir, providerDir, root]) {
      try {
        Object.assign(ubjsNatives, platformNatives(base, name, ubjsSeen).natives)
        break
      } catch { /* 换下一个基准目录 */ }
    }
  }
  if (Object.keys(ubjsNatives).length === 0) {
    const detail = Object.entries(ubjsSeen).map(([name, deps]) => `${name}: ${deps.join(', ') || '（未找到）'}`).join(' | ')
    throw new Error(`patch-desktop-computer-use: 找不到 ubjs 的 ${PLATFORM_SUFFIX} 平台原生包（${detail}）`)
  }
  Object.assign(wanted, ubjsNatives)

  const dshPackage = findWorkspacePackage(root, '@deepseek-ai/dsh')
  if (dshPackage === undefined) {
    throw new Error('patch-desktop-computer-use: workspace 里找不到 @deepseek-ai/dsh 的 package.json，插件行会解析不到')
  }

  const added = {}
  for (const manifestRel of [...MANIFESTS, dshPackage]) {
    const targetPath = join(root, manifestRel)
    const target = JSON.parse(readFileSync(targetPath, 'utf8'))
    if (target.dependencies === undefined || typeof target.dependencies !== 'object' || target.dependencies === null) {
      throw new Error(`patch-desktop-computer-use: ${manifestRel} 没有 dependencies 对象，上游改了结构？`)
    }
    added[manifestRel] = []
    for (const [name, version] of Object.entries(wanted)) {
      if (target.dependencies[name] !== undefined) continue
      target.dependencies[name] = version
      added[manifestRel].push(name)
    }
    if (added[manifestRel].length > 0) writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n')
  }
  return { added, unpacked: patchAsarUnpack(root), libPath: patchUbjsLibPath(root) }
}

/** @ubjs/node 里算原生库路径的文件。 */
const UBJS_LIB = 'node_modules/@ubjs/node/typescript/dist/resolve-lib.js'
/** 两条锚点，缺一即报错（上游换实现时要立刻知道，而不是静默失效）。 */
const UBJS_ANCHORS = {
  binaryPath: '    const binaryPath = (0, node_path_1.join)((0, node_path_1.dirname)(pkgJsonPath), libFileName(crateName, process.platform));',
  ret: '    return binaryPath;',
}
/** 幂等标记。 */
const UBJS_MARK = 'dsh-build asar fix'
/** 插入体：把 asar 路径映射到 asar 外的真实副本，且**不做存在性判断** —— Electron 的 fs 垫片把
 *  "app.asar.unpacked/…" 也当成 asar 内路径去找，existsSync 会返回 false 而把映射否掉；
 *  而原生代码（Rust LoadLibrary）拿的是真实路径，本来就能打开。不在 asar 里时行为不变。 */
const UBJS_FIX_BODY = [
  '    // [dsh-build asar fix] 原生库由原生代码自己打开（Rust LoadLibrary），不走 Electron 的 asar',
  '    // 垫片 —— 形如 …/app.asar/… 的路径打不开（os error 126）。这里直接映射到 asar 外的真实副本，',
  '    // 不做存在性判断：垫片会把 "app.asar.unpacked/…" 也当成 asar 内路径去找。',
  "    const unpackedBinary = binaryPath.replace(/app[.]asar([\\\\/])/u, 'app.asar.unpacked$1');",
  '    return unpackedBinary;',
].join('\n')

/** 给一个 resolve-lib.js 打补丁；已打过返回 false。锚点缺失抛错。 */
function applyUbjsFix(path) {
  const source = readFileSync(path, 'utf8')
  if (source.includes(UBJS_MARK)) return false
  for (const [name, anchor] of Object.entries(UBJS_ANCHORS)) {
    if (!source.includes(anchor)) {
      throw new Error(`patch-desktop-computer-use: ${path} 里找不到 ${name} 锚点，@ubjs 换了实现？`)
    }
  }
  writeFileSync(path, source
    .replace(UBJS_ANCHORS.ret, '    return unpackedBinary;')
    .replace(UBJS_ANCHORS.binaryPath, UBJS_ANCHORS.binaryPath + '\n' + UBJS_FIX_BODY))
  return true
}

/**
 * 给构建树里的 @ubjs/node 打上原生库路径映射（幂等）。
 *
 * 病根：Cua Driver 的原生库路径由 resolveLibPath() 从调用方的 import.meta.url 推出；在 Electron
 * 里即使模块被解到 asar 外，import.meta.url 仍是 …/app.asar/…，而 Rust 侧 LoadLibrary 不走垫片，
 * 于是 os error 126（同一份文件从 app.asar.unpacked 打开正常，返回 56 个工具）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ patched: string[], candidates: string[] }} 已打补丁的文件与候选。
 */
export function patchUbjsLibPath(root) {
  const candidates = []
  const direct = join(root, UBJS_LIB)
  if (existsSync(direct)) candidates.push(direct)
  const pnpmDir = join(root, 'node_modules/.pnpm')
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('@ubjs+node@')) continue
      const candidate = join(pnpmDir, entry, 'node_modules/@ubjs/node/typescript/dist/resolve-lib.js')
      if (existsSync(candidate)) candidates.push(candidate)
    }
  }
  if (candidates.length === 0) {
    throw new Error(`patch-desktop-computer-use: 找不到 ${UBJS_LIB}（pnpm store 里也没有），asar 原生库修复无法应用`)
  }
  const patched = candidates.filter((path) => applyUbjsFix(path))
  return { patched, candidates }
}

/**
 * 对打包产物里那份 resolve-lib.js 补一次同样的映射（幂等）。
 *
 * dsh 树是在打包阶段才从 tarball + pnpm 装出来的，构建期打不到它；可靠的位置只有打包完成后
 * asar 外面那份真实文件（resources/app.asar.unpacked/dsh/node_modules/@ubjs/…）—— Electron
 * 读 asar 路径时会重定向到它。
 * @param {string} path - resolve-lib.js 的绝对路径。
 * @returns {boolean} 本次是否写入。
 */
export function patchUbjsFile(path) {
  if (!existsSync(path)) {
    throw new Error(`patch-desktop-computer-use: 打包产物里找不到 ${path}（@ubjs 没被解出来？）`)
  }
  return applyUbjsFix(path)
}

/**
 * 把 @trycua / @ubjs 两棵原生树的整棵解到 asar 外面。
 *
 * 上游的 asarUnpack 只解 .node/.dll/.so/.exe，JS 仍留在 asar 里；而映射补丁要能生效，需要
 * @ubjs 的 resolve-lib.js 在 asar 外有真实副本（打包后补打的就是它）。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ changed: boolean, path: string }} 是否改动与改动的文件。
 */
export function patchAsarUnpack(root) {
  const path = join(root, BUILDER_CONFIG)
  const source = readFileSync(path, 'utf8')
  if (source.includes("'**/@trycua/**'")) return { changed: false, path }
  if (!source.includes(UNPACK_ANCHOR)) {
    throw new Error(`patch-desktop-computer-use: ${BUILDER_CONFIG} 里找不到 asarUnpack 锚点，上游改了结构？`)
  }
  writeFileSync(path, source.replace(UNPACK_ANCHOR, UNPACK_ANCHOR + '\n' + UNPACK_PATTERNS))
  return { changed: true, path }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('用法: node patch-desktop-computer-use.mjs <upstream-repo-root>')
  const { added, unpacked, libPath } = patchDesktopComputerUse(root)
  const parts = Object.entries(added).map(([manifest, names]) =>
    manifest + ': ' + (names.length === 0 ? '（已声明，无改动）' : names.join(', ')))
  if (unpacked.changed) parts.push('asarUnpack: 已补 @trycua/** @ubjs/** 解包')
  parts.push('@ubjs asar 映射: ' + (libPath.patched.length > 0 ? '已打 ' + libPath.patched.length + ' 处' : '已在位'))
  console.log('patch-computer-use: ' + parts.join(' | '))
}
