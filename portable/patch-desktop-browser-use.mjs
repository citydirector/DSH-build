// patch-desktop-browser-use.mjs <upstream-repo-root>
//
// 让官方 browser-use 在桌面端可用。只做一件事，幂等：
//
//   声明依赖：把注册表（@deepseek-ai/dsh-browser-use）、共享运行时
//   （@deepseek-ai/dsh-experimental-browser-use-runtime）、选定的提供方（PROVIDER）以及提供方
//   自己的 registry 依赖（chrome-devtools-mcp）写进三份清单 —— apps/desktop-host（产出运行时树
//   dsh/）、apps/desktop（asar 根）、@deepseek-ai/dsh 本体（加载器按它的 dependencies ∪
//   peerDependencies 决定哪些包能被 profile 的插件行解析，缺一不可）。版本取自构建树里已安装的
//   清单，上游升级自动跟随。
//
//   为什么"随包"而不是"在 profile 里装"：上游提供方的 peerDependencies 是**精确版本**
//   （如 0.2.0-rc.2，只有 cordis 是 ~），profile 安装会被钉死在当时的 harness 上，harness 每次
//   升版都被兼容门禁判为不兼容而跳过；随包发行才与 app 同生共死。上游 issue 已禁用
//   （deepseek-ai/deepseek-harness hasIssuesEnabled=false），这条路提不上去。
//
//   与 computer-use 的差别：browser-use 这一族全是纯 JS，没有原生模块 —— 不需要 asarUnpack，
//   也不需要原生库路径映射，所以本文件比 patch-desktop-computer-use.mjs 短得多。
//
//   同一部署同一时刻只能启用**一个**提供方（注册名冲突会加载失败），所以这里只声明 PROVIDER
//   那一个。换提供方 = 改下面这一行常量（候选见 PROVIDER_ALTERNATIVES）。
//
// 用法: node patch-desktop-browser-use.mjs <repo-root>
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'

import { basename, dirname, join, relative } from 'node:path'

/** 依赖要声明进的三份清单（见文件头）。 */
const MANIFESTS = [
  'apps/desktop-host/package.json',
  'apps/desktop/package.json',
]

/** 选定的提供方（唯一可启用者）。 */
const PROVIDER = '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'
/** 提供方所在 workspace 目录（pnpm 把它的依赖链接在它自己的 node_modules 下）。 */
const PROVIDER_DIR = 'packages/experimental/browser-use-chrome-devtools-mcp'

/** 其它可选的提供方，换 PROVIDER 时连同 PROVIDER_DIR 一起改。 */
export const PROVIDER_ALTERNATIVES = [
  { name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp', dir: 'packages/experimental/browser-use-chrome-devtools-mcp' },
  { name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', dir: 'packages/experimental/browser-use-playwright-mcp' },
  { name: '@deepseek-ai/dsh-experimental-browser-use-stagehand-native', dir: 'packages/experimental/browser-use-stagehand-native' },
]

/** 必须出现在产物里的插件包：注册表在前（它提供 browserUse 服务，提供方 inject 它）。 */
export const RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-browser-use',
  '@deepseek-ai/dsh-experimental-browser-use-runtime',
  PROVIDER,
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

/** 取提供方声明的 registry 依赖（跳过 workspace 的 @deepseek-ai/*，那些由 RUNTIME_PACKAGES 声明）。
 *  版本取构建树里**实际装的那份**的 version —— 不抄上游的 range，避免声明的与装的对不上。
 *  @param {string} providerDir - 提供方所在 workspace 目录（清单直接读它，不走 node_modules 链：
 *    它本身就是 workspace 包，不在任何 node_modules 下）。
 *  @param {string} name - 提供方包名（核对用，挪位置/改名时立刻报错）。
 *  @returns {{ version: string, deps: Record<string, string> }} */
function registryDeps(providerDir, name) {
  const manifest = JSON.parse(readFileSync(join(providerDir, 'package.json'), 'utf8'))
  if (manifest.name !== name) {
    throw new Error(`patch-desktop-browser-use: ${providerDir}/package.json 的 name 是 ${String(manifest.name)}，期望 ${name}`)
  }
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies }
  const deps = {}
  for (const dep of Object.keys(declared)) {
    if (dep.startsWith('@deepseek-ai/')) continue
    const installed = findPackage(providerDir, dep)
    if (installed === undefined) {
      throw new Error(`patch-desktop-browser-use: ${name} 声明了 ${dep}，但构建树里找不到它（pnpm install 没跑到？）`)
    }
    deps[dep] = installed.manifest.version
  }
  return { version: manifest.version, deps }
}

/** 把三个插件包与提供方的 registry 依赖写进三份清单（幂等）。
 *  @param {string} root - upstream 仓库根目录。
 *  @returns {{ provider: string, version: string, added: Record<string, string[]> }} */
export function patchDesktopBrowserUse(root) {
  const providerDir = join(root, PROVIDER_DIR)
  if (!existsSync(join(providerDir, 'package.json'))) {
    throw new Error(`patch-desktop-browser-use: 找不到提供方目录 ${PROVIDER_DIR}，上游挪了位置？`)
  }

  const wanted = Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, 'workspace:*']))
  let provider
  try {
    provider = registryDeps(providerDir, PROVIDER)
  } catch (error) {
    const hints = [
      `provider/node_modules=${existsSync(join(providerDir, 'node_modules'))}`,
      `root/node_modules/.pnpm=${existsSync(join(root, 'node_modules', '.pnpm'))}`,
    ].join(' ')
    throw new Error(`${error instanceof Error ? error.message : String(error)} [${hints}]`, { cause: error })
  }
  Object.assign(wanted, provider.deps)

  const dshPackage = findWorkspacePackage(root, '@deepseek-ai/dsh')
  if (dshPackage === undefined) {
    throw new Error('patch-desktop-browser-use: workspace 里找不到 @deepseek-ai/dsh 的 package.json，插件行会解析不到')
  }

  const added = {}
  for (const manifestRel of [...MANIFESTS, dshPackage]) {
    const targetPath = join(root, manifestRel)
    const target = JSON.parse(readFileSync(targetPath, 'utf8'))
    if (target.dependencies === undefined || typeof target.dependencies !== 'object' || target.dependencies === null) {
      throw new Error(`patch-desktop-browser-use: ${manifestRel} 没有 dependencies 对象，上游改了结构？`)
    }
    added[manifestRel] = []
    for (const [name, version] of Object.entries(wanted)) {
      if (target.dependencies[name] !== undefined) continue
      target.dependencies[name] = version
      added[manifestRel].push(name)
    }
    if (added[manifestRel].length > 0) writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n')
  }
  return { provider: PROVIDER, version: provider.version, added }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('用法: node patch-desktop-browser-use.mjs <upstream-repo-root>')
  const { provider, version, added } = patchDesktopBrowserUse(root)
  const parts = Object.entries(added).map(([manifest, names]) =>
    manifest + ': ' + (names.length === 0 ? '（已声明，无改动）' : names.join(', ')))
  console.log(`patch-browser-use: ${provider}@${version} | ` + parts.join(' | '))
}
