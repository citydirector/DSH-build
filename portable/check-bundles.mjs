// check-bundles.mjs <app-node-modules> [--profile <profile-dir>] [--self-test]
//
// 校验「随包的 dsh 应用是否真的撑得住它对外宣称的 bundle」——这是插件面板那个"官方包出现在
// 自定义栏"现象背后真正的隐患：
//
//   · 面板的分区由两个**硬编码名单**决定：客户端 `BUILTIN_PROFILE_BUNDLES`（被藏起来的核心
//     bundle）与宿主 `OPTIONAL_BUNDLES`（"官方"区里可选装的那几个）。名单之外的官方 bundle
//     会以卡片形式出现在「已安装」/「官方」区，看起来就像它闯进了你自己的插件栏。
//   · 更实质的是 `dsh.profile.bundles` 与 `dependencies` **解耦**：profile 选中一个 bundle
//     不等于安装它，能否解析完全取决于随包内容（`app/node_modules`）。上游的安装器（完整
//     依赖图）总能兜住；我们的便携包是 `pnpm deploy` 的子集，兜不兜得住得**验证**。
//   · 面板上的开关（`setBundleEnabled`）只写 `dsh.profile.bundles`，**不会安装**。所以一个
//     "选中但没随包"的 bundle 无法靠面板自救，只会在启动/行加载时失败。
//
// 名单不写死：从**已部署的包里**解析（`@deepseek-ai/dsh-app-boot` 的 DEFAULT_PROFILE_BUNDLES /
// OPTIONAL_BUNDLES、`@deepseek-ai/dsh-client-ui-plugin-manager` 的 BUILTIN_PROFILE_BUNDLES），
// 上游改名/新增会自动覆盖到。解析不出来（上游改了写法）→ 退出码 2，逼人来看，而不是静默放过。
//
// 用法：
//   node check-bundles.mjs <app>/node_modules
//   node check-bundles.mjs <app>/node_modules --profile <data>/profiles/web
//   node check-bundles.mjs --self-test
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const APP_BOOT = '@deepseek-ai/dsh-app-boot/lib/index.js'
const PLUGIN_MANAGER_CLIENT = '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js'

/** 从一个数组/Set 字面量源码里抠出带引号的字符串。 */
function quoted(text) {
  return [...text.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
}

/** 抠 `const NAME = [...]` / `const NAME = new Set([...])` 里的字符串。 */
function extractConst(source, name) {
  const array = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`)
  const set = new RegExp(`const ${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`)
  const m = array.exec(source) ?? set.exec(source)
  return m === null ? null : quoted(m[1])
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 解析一个包名到实际目录；`source` 说明它是靠 app 还是 profile 兜住的。 */
function locate(name, appNodeModules, profileDir) {
  const inApp = join(appNodeModules, name, 'package.json')
  const inProfile = profileDir === undefined ? null : join(profileDir, 'node_modules', name, 'package.json')
  const appOk = existsSync(inApp)
  const profileOk = inProfile !== null && existsSync(inProfile)
  return {
    name,
    appOk,
    profileOk,
    source: appOk && profileOk ? '随包 + profile 依赖' : appOk ? '随包' : profileOk ? 'profile 依赖' : '缺失',
  }
}

function check(appNodeModules, profileDir) {
  const problems = []
  const bootSrc = readIfPresent(join(appNodeModules, APP_BOOT))
  const clientSrc = readIfPresent(join(appNodeModules, PLUGIN_MANAGER_CLIENT))
  if (bootSrc === null || clientSrc === null) {
    console.error(`check-bundles: 找不到 ${bootSrc === null ? APP_BOOT : PLUGIN_MANAGER_CLIENT}（app-node-modules 传对了吗？）`)
    return 2
  }

  const defaults = extractConst(bootSrc, 'DEFAULT_PROFILE_BUNDLES')
  const optional = extractConst(bootSrc, 'OPTIONAL_BUNDLES')
  const builtin = extractConst(clientSrc, 'BUILTIN_PROFILE_BUNDLES')
  if (defaults === null || optional === null || builtin === null || defaults.length === 0 || optional.length === 0 || builtin.length === 0) {
    console.error('check-bundles: 名单解析失败或为空 —— 上游改了这几行，请人工核对本脚本的正则：')
    console.error(`  DEFAULT_PROFILE_BUNDLES=${JSON.stringify(defaults)}`)
    console.error(`  OPTIONAL_BUNDLES=${JSON.stringify(optional)}`)
    console.error(`  BUILTIN_PROFILE_BUNDLES=${JSON.stringify(builtin)}`)
    return 2
  }

  console.log(`check-bundles: 从已部署包里解析出 DEFAULT=${defaults.length} OPTIONAL=${optional.length} BUILTIN=${builtin.length}`)
  console.log(`  DEFAULT : ${defaults.join(', ')}`)
  console.log(`  OPTIONAL: ${optional.join(', ')}`)
  console.log(`  BUILTIN : ${builtin.join(', ')}`)

  console.log('')
  console.log('随包必须撑住的（DEFAULT ∪ OPTIONAL ∪ BUILTIN）：')
  const advertised = [...new Set([...defaults, ...optional, ...builtin])]
  for (const name of advertised) {
    const r = locate(name, appNodeModules, profileDir)
    console.log(`  ${r.appOk ? '✓' : '✗'} ${name}${r.appOk ? '' : `  ← ${r.source}`}`)
    if (!r.appOk) problems.push(`${name}（对外宣称可选/内置，但不在 app/node_modules 里）`)
  }

  if (profileDir !== undefined) {
    const manifestPath = join(profileDir, 'package.json')
    if (!existsSync(manifestPath)) {
      console.error(`\ncheck-bundles: 给了 --profile，但 ${manifestPath} 不存在`)
      return 2
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const declared = manifest?.dsh?.profile?.bundles ?? []
    const deps = Object.keys(manifest?.dependencies ?? {})
    const optionalSet = new Set(optional)
    console.log('')
    console.log(`profile 声明的 bundle（${declared.length} 个）与它们的兜底来源：`)
    for (const name of declared) {
      const r = locate(name, appNodeModules, profileDir)
      const alsoDep = deps.includes(name)
      const suffix = r.source === '随包' && alsoDep ? '（同时是 profile 依赖）' : ''
      console.log(`  ${r.source === '缺失' ? '✗' : '✓'} ${name}  ← ${r.source}${suffix}`)
      if (r.source === '缺失') problems.push(`${name}（profile 选中了它，但既不在随包里、也不是 profile 依赖 —— 启动时这一条会加载失败）`)
      else if (r.source === '随包' && !alsoDep && optionalSet.has(name)) {
        console.log('      ⚠ 上游把这一类标成"可选 bundle"（设计上由安装依赖图兜住），这里却没声明为 profile 依赖 ——')
        console.log('        只靠随包兜着；面板的开关只改 dsh.profile.bundles、不会安装，随包一旦不含它就断。')
      }
    }
    console.log('')
    console.log(`profile 依赖（${deps.length} 个）：`)
    for (const name of deps) {
      const r = locate(name, appNodeModules, profileDir)
      console.log(`  ${r.profileOk || r.appOk ? '✓' : '✗'} ${name}  ← ${r.source}`)
      if (!r.profileOk && !r.appOk) problems.push(`${name}（profile 依赖，但两边都找不到 —— 先跑一次插件面板的安装/重试）`)
    }
  }

  console.log('')
  if (problems.length > 0) {
    console.error('check-bundles: ✗ 发现 ' + problems.length + ' 个问题：')
    for (const p of problems) console.error(`  !! ${p}`)
    return 1
  }
  console.log('check-bundles: ✓ 没有发现悬空的 bundle')
  return 0
}

/** 用一个假树证明"缺 bundle 会说 ✗ 而不是静默通过"。 */
function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-bundles-'))
  const nm = join(base, 'node_modules')
  const mk = (rel, text) => {
    mkdirSync(join(nm, rel, '..'), { recursive: true })
    writeFileSync(join(nm, rel), text)
  }
  const boot = 'const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];\nconst OPTIONAL_BUNDLES = [\n\t"@deepseek-ai/dsh-experimental-lost"\n];\n'
  const client = 'const BUILTIN_PROFILE_BUNDLES = new Set([\n\t"@deepseek-ai/dsh-base"\n]);\n'
  mk(APP_BOOT, boot)
  mk(PLUGIN_MANAGER_CLIENT, client)
  // 故意只装 base，让 experimental-lost 缺位
  mk('@deepseek-ai/dsh-base/package.json', '{"name":"@deepseek-ai/dsh-base","version":"0.0.0"}')
  const profile = join(base, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-lost'] } },
  }))

  console.log('== self-test：缺一个官方可选 bundle，看它是否报错 ==')
  const code = check(nm, profile)
  rmSync(base, { recursive: true, force: true })
  if (code === 1) {
    console.log('self-test: ✓ 缺 bundle 时返回 1（不是静默通过）')
    return 0
  }
  console.error(`self-test: ✗ 期望返回 1，实际 ${code}`)
  return 1
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) {
  process.exit(selfTest())
}
const appArg = argv.find((a) => !a.startsWith('--'))
const profileFlag = argv.indexOf('--profile')
if (appArg === undefined) {
  console.error('用法: node check-bundles.mjs <app-node-modules> [--profile <profile-dir>] [--self-test]')
  process.exit(2)
}
if (profileFlag >= 0 && argv[profileFlag + 1] === undefined) {
  console.error('--profile 后面要给一个目录')
  process.exit(2)
}
process.exit(check(resolve(appArg), profileFlag >= 0 ? resolve(argv[profileFlag + 1]) : undefined))
