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
import { createRequire } from 'node:module'
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

/** 解析包入口后向上找最近的 package.json（绕开 exports 不暴露 ./package.json 的包）。 */
function manifestOf(req, name) {
  let dir
  try {
    dir = dirname(req.resolve(name))
  } catch (error) {
    throw new Error(`patch-desktop-computer-use: 解析不到 ${name} 的入口（构建树里没装？）`, { cause: error })
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) return { dir, manifest: JSON.parse(readFileSync(candidate, 'utf8')) }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`patch-desktop-computer-use: ${name} 的目录树里找不到 package.json（入口 ${dir}）`)
}

/** 从某个包的清单里挑出与构建平台匹配的原生 optionalDependencies。 */
function platformNatives(req, name) {
  const { manifest } = manifestOf(req, name)
  const picked = {}
  for (const [dep, version] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (dep.endsWith(PLATFORM_SUFFIX)) picked[dep] = version
  }
  return picked
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

  const providerManifest = join(root, PROVIDER_DIR, 'package.json')
  if (!existsSync(providerManifest)) {
    throw new Error(`patch-desktop-computer-use: 找不到提供方目录 ${PROVIDER_DIR}，上游挪了位置？`)
  }
  const providerReq = createRequire(providerManifest)

  const wanted = { ...RUNTIME_PACKAGES.reduce((acc, name) => ({ ...acc, [name]: 'workspace:*' }), {}) }
  let sdkNatives
  try {
    sdkNatives = platformNatives(providerReq, '@trycua/cua-driver')
  } catch (error) {
    // 现场诊断：这三处就能定位"没装 / 装到别处 / 位置变了"
    const hints = [
      `provider/node_modules=${existsSync(join(root, PROVIDER_DIR, 'node_modules'))}`,
      `root/node_modules/@trycua=${existsSync(join(root, 'node_modules', '@trycua'))}`,
      `root/node_modules/.pnpm/@trycua*=${existsSync(join(root, 'node_modules', '.pnpm'))}`,
    ].join(' ')
    throw new Error(`${error instanceof Error ? error.message : String(error)} [${hints}]`, { cause: error })
  }
  const sdkNative = Object.keys(sdkNatives).find((name) => name.startsWith('@trycua/cua-driver-'))
  if (sdkNative === undefined) {
    throw new Error(`patch-desktop-computer-use: @trycua/cua-driver 没有 ${PLATFORM_SUFFIX} 平台原生包`)
  }
  Object.assign(wanted, sdkNatives)

  // ubjs 的平台原生（@ubjs/node-<suffix>）挂在 SDK 的解析基准下；没有平台原生依赖是正常的
  const sdkEntry = manifestOf(providerReq, '@trycua/cua-driver')
  const sdkReq = createRequire(join(sdkEntry.dir, 'package.json'))
  for (const name of ['@ubjs/core', '@ubjs/node']) {
    try {
      Object.assign(wanted, platformNatives(sdkReq, name))
    } catch {
      // 忽略：该包可能没有平台原生依赖
    }
  }

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
