// patch-desktop-computer-use.mjs <upstream-repo-root>
//
// 把官方 computer-use 相关的包声明成桌面端的**运行时依赖**，好让 electron-builder 把它们
// 连同原生二进制一起打进 resources/app.asar：
//
//   @deepseek-ai/dsh-computer-use                                 提供 computerUse 服务的注册表
//   @deepseek-ai/dsh-experimental-computer-use-cua-driver-native  原生提供方（进程内 Cua Driver）
//   <平台原生包>                                                  SDK 与 ubjs 的平台二进制
//
// 两个实跑踩出来的坑，都在这里处理掉了：
//   1) 平台原生包是 SDK / ubjs 的 **optionalDependencies**，而 electron-builder 收集依赖时不带
//      optional 依赖 —— 第一版补丁跑完，asar 里三个包都在、app.asar.unpacked 里一个 .node 都没有，
//      等于发了个装不上原生运行时的 computer use。所以它们必须被声明成**直接依赖**。
//   2) 不能直接 `require('<pkg>/package.json')` 读清单：现代包（cua-driver 就是）在 exports 里
//      没有暴露 ./package.json，会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。改走「解析包入口 → 向上找
//      最近的 package.json」。
//
// 版本不写死：从构建树里**已安装的清单**读（SDK 的 optionalDependencies 里挑与构建平台后缀匹配
// 的那几个），上游升级 SDK 时这里自动跟上。读不到就抛错并打印现场（provider/node_modules 在不在、
// root/@trycua 在不在），宁可构建失败，也不要静默出一个没有原生二进制的包。
//
// 为什么必须在打包前做：桌面包里的应用是 asar（打包后再塞东西要动 asar 结构，原生 .node 还得
// 同时落到 app.asar.unpacked），所以只能走依赖闭包。便携版不用这个脚本：app/ 是散目录，构建期
// 用 patch-peers + patch-dep 直接补齐（见 workflow 的 "Patch runtime deps" 与
// "Assert the Cua Driver SDK shipped"）。
//
// 用法: node patch-desktop-computer-use.mjs <repo-root>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { dirname, join } from 'node:path'

const APP_PACKAGE = 'apps/desktop/package.json'
/** 上游 workspace 里原生提供方所在目录（pnpm 把它的依赖链接在它自己的 node_modules 下）。 */
const PROVIDER_DIR = 'packages/experimental/computer-use-cua-driver-native'
/** 构建平台后缀，与原生包名尾部一致（win32-x64 / darwin-arm64 / linux-x64 …）。 */
const PLATFORM_SUFFIX = `${process.platform}-${process.arch}`

/** 必须出现在产物里的两个包：注册表在前（提供方 inject 它提供的服务）。 */
export const RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-computer-use',
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
]

/** 逐级向上找 `<dir>/node_modules/<name>` —— 就是 node 的解析算法，但不走 exports，
 * 于是既能处理"exports 不暴露 ./package.json"，也能处理 ESM-only 包（只有 import 条件时
 * require.resolve 会失败）。pnpm 的 isolated 布局里那些链接也照常命中。 */
function findPackage(startDir, name) {
  let dir = startDir
  for (let depth = 0; depth < 12; depth += 1) {
    const packageDir = join(dir, 'node_modules', name)
    const candidate = join(packageDir, 'package.json')
    if (existsSync(candidate)) {
      return { dir: packageDir, manifest: JSON.parse(readFileSync(candidate, 'utf8')) }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 取包清单；找不到就抛错（由调用方补现场信息）。 */
function manifestOf(startDir, name) {
  const found = findPackage(startDir, name)
  if (found === undefined) throw new Error(`patch-desktop-computer-use: 在 ${startDir} 往上的 node_modules 里找不到 ${name}`)
  return found
}

/** 平台词表：名字里同时命中本平台与本架构、且不含任何别的平台/架构词，才算平台原生包。
 * 真实命名带工具链后缀（win32-x64-msvc / linux-x64-gnu / darwin-arm64），所以不能用
 * endsWith('<platform>-<arch>') 去匹配 —— 那是实跑踩到的坑之一。 */
const PLATFORM_TOKENS = { win32: ['win32', 'windows'], darwin: ['darwin', 'macos'], linux: ['linux'] }
const ARCH_TOKENS = { x64: ['x64', 'amd64'], arm64: ['arm64', 'aarch64'] }

export function matchesPlatformName(name) {
  const lower = name.toLowerCase()
  const groups = [PLATFORM_TOKENS, ARCH_TOKENS]
  const current = [process.platform, process.arch]
  for (let index = 0; index < groups.length; index += 1) {
    const table = groups[index]
    const key = current[index]
    // 本平台/本架构：任一别名命中即可（win32 / windows 是"或"，不是"且"）
    const tokens = table[key] ?? [key]
    if (!tokens.some((token) => lower.includes(token))) return false
    // 别的平台/架构：一个都不许沾（否则 win32-arm64 / linux-x64 都会被误收）
    for (const [otherKey, otherTokens] of Object.entries(table)) {
      if (otherKey === key) continue
      if (otherTokens.some((token) => lower.includes(token))) return false
    }
  }
  return true
}

/** 取某个包声明的平台原生依赖（dependencies 与 optionalDependencies 都看）。
 * @param {string} startDir - 从这个目录开始向上找包。
 * @param {string} name - 包名。
 * @param {Record<string, string[]>} [seen] - 诊断用：记录每个包声明过的依赖名。
 */
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

/**
 * 幂等地把 runtime 依赖（含平台原生包）写进桌面端 manifest。
 * @param {string} root - upstream 仓库根目录。
 * @returns {{ added: string[], packagePath: string }} 本次新增的包名与改动的文件。
 */
export function patchDesktopComputerUse(root) {
  const packagePath = join(root, APP_PACKAGE)
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (manifest.dependencies === undefined || typeof manifest.dependencies !== 'object' || manifest.dependencies === null) {
    throw new Error(`patch-desktop-computer-use: ${APP_PACKAGE} 没有 dependencies 对象，上游改了结构？`)
  }

  const providerDir = join(root, PROVIDER_DIR)
  const providerManifest = join(providerDir, 'package.json')
  if (!existsSync(providerManifest)) {
    throw new Error(`patch-desktop-computer-use: 找不到提供方目录 ${PROVIDER_DIR}，上游挪了位置？`)
  }

  const wanted = { ...RUNTIME_PACKAGES.reduce((acc, name) => ({ ...acc, [name]: 'workspace:*' }), {}) }
  const declaredSeen = {}
  let sdk
  try {
    sdk = platformNatives(providerDir, '@trycua/cua-driver', declaredSeen)
  } catch (error) {
    // 现场诊断：这三处就能定位"没装 / 装到别处 / 位置变了"
    const hints = [
      `provider/node_modules=${existsSync(join(providerDir, 'node_modules'))}`,
      `root/node_modules/@trycua=${existsSync(join(root, 'node_modules', '@trycua'))}`,
      `root/node_modules/.pnpm=${existsSync(join(root, 'node_modules', '.pnpm'))}`,
    ].join(' ')
    throw new Error(`${error instanceof Error ? error.message : String(error)} [${hints}]`, { cause: error })
  }
  const sdkNative = Object.keys(sdk.natives).find((name) => name.startsWith('@trycua/cua-driver-'))
  if (sdkNative === undefined) {
    // 把实际声明过的依赖打出来 —— 下次命名规则再变，这条错误自己就说清了
    throw new Error(`patch-desktop-computer-use: @trycua/cua-driver@${sdk.version} 里找不到 ${PLATFORM_SUFFIX} 平台的包（它声明的依赖：${(declaredSeen['@trycua/cua-driver'] ?? []).join(', ')}）`)
  }
  Object.assign(wanted, sdk.natives)

  // ubjs 的平台原生（@ubjs/node-<suffix>）挂在 SDK 的依赖树下。它必须找到 —— 上一版把它
  // try/catch 静默吞了，结果打出一个没有 ubjs 原生、跑不起来的包。找不到就报错并打印现场。
  const ubjsNatives = {}
  const ubjsSeen = {}
  for (const name of ['@ubjs/core', '@ubjs/node']) {
    for (const base of [sdk.dir, providerDir, root]) {
      try {
        Object.assign(ubjsNatives, platformNatives(base, name, ubjsSeen).natives)
        break
      } catch {
        // 换下一个基准目录再试
      }
    }
  }
  if (Object.keys(ubjsNatives).length === 0) {
    const detail = Object.entries(ubjsSeen).map(([name, deps]) => `${name}: ${deps.join(', ') || '（未找到）'}`).join(' | ')
    throw new Error(`patch-desktop-computer-use: 找不到 ubjs 的 ${PLATFORM_SUFFIX} 平台原生包（${detail}）`)
  }
  Object.assign(wanted, ubjsNatives)

  const added = []
  for (const [name, version] of Object.entries(wanted)) {
    if (manifest.dependencies[name] !== undefined) continue
    manifest.dependencies[name] = version
    added.push(name)
  }
  if (added.length > 0) writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n')
  return { added, packagePath }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('用法: node patch-desktop-computer-use.mjs <upstream-repo-root>')
  const { added } = patchDesktopComputerUse(root)
  console.log(added.length === 0
    ? 'patch-computer-use: 依赖已声明，无改动'
    : 'patch-computer-use: 新增依赖 ' + added.join(', '))
}
