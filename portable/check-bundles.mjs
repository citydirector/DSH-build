// check-bundles.mjs <app-node-modules> [--profile <profile-dir>] [--self-test]
//
// 校验随包的 dsh 应用是否撑得住它对外宣称的 bundle：面板分区靠几个硬编码名单（客户端
// HIDDEN_BUNDLES / 宿主 OPTIONAL_BUNDLES），而 profile 的 dsh.profile.bundles 与
// 「是否随包」解耦 —— 选中不等于安装，面板开关也只写 bundles；我们的便携包是 pnpm deploy 的
// 子集，兜不兜得住必须验，否则只会在启动时行加载失败。
//
// 名单不写死：从已部署的包里解析，上游改名/搬家会自动跟随；解析不出来 → 退出码 2（逼人来看，
// 不静默放过）。
//
// 名单住在哪：0.2.1 起上游把官方名单从 app-boot 搬进新包 @deepseek-ai/dsh-official-bundles
// （refactor(boot): move official bundle lists out of app-boot），客户端那份也从
// BUILTIN_PROFILE_BUNDLES 改名为 HIDDEN_BUNDLES。所以按「新位置 → 旧位置」逐级回退，
// 新旧上游都能跑。
//
// 用法：
//   node check-bundles.mjs <app>/node_modules
//   node check-bundles.mjs <app>/node_modules --profile <data>/profiles/web
//   node check-bundles.mjs --self-test
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** 宿主名单的候选位置，按「新 → 旧」排序；第一个解析出非空名单的胜出。 */
export const HOST_BUNDLE_SOURCES = [
  { label: '@deepseek-ai/dsh-official-bundles', path: '@deepseek-ai/dsh-official-bundles/lib/index.js' },
  { label: '@deepseek-ai/dsh-app-boot', path: '@deepseek-ai/dsh-app-boot/lib/index.js' },
]
/** 客户端名单的候选位置（同一个常量在新上游搬到这里）。 */
export const CLIENT_BUNDLE_SOURCE = { label: '@deepseek-ai/dsh-client-ui-plugin-manager', path: '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js' }
/** 「内置 bundle」在上下游的两个名字：0.2.1 起 HIDDEN_BUNDLES，之前 BUILTIN_PROFILE_BUNDLES。 */
export const BUILTIN_NAMES = ['HIDDEN_BUNDLES', 'BUILTIN_PROFILE_BUNDLES']

/** 从一个数组/Set 字面量源码里抠出带引号的字符串。 */
function quoted(text) {
  return [...text.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
}

/**
 * 抠 `const NAME = [...]` / `const NAME = new Set([...])` 里的字符串。
 *
 * 名字与 `=` 之间允许夹类型标注：源码态写作
 * `const RETIRED_BUNDLES: ReadonlySet<string> = new Set([...])`，那一段用 `[^=]*` 吞掉。
 */
export function extractConst(source, name) {
  const array = new RegExp(`const ${name}\\s*[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
  const set = new RegExp(`const ${name}\\s*[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`)
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

/**
 * 按「新 → 旧」顺序读源码，返回第一份能解析出非空名单的取值。
 * @param {Array<{label: string, path: string}>} sources - 候选位置。
 * @param {readonly string[]} names - 同一个常量的候选名（新旧改名），按优先级。
 * @param {string} appNodeModules - 随包 node_modules。
 * @returns {{ value: string[] | null, from: string | null, tried: string[] }}
 */
export function firstList(sources, names, appNodeModules) {
  const tried = []
  for (const source of sources) {
    const text = readIfPresent(join(appNodeModules, source.path))
    if (text === null) {
      tried.push(`${source.label}: 文件不存在`)
      continue
    }
    for (const name of names) {
      const value = extractConst(text, name)
      if (value !== null && value.length > 0) return { value, from: `${source.label} 的 ${name}`, tried }
      tried.push(`${source.label}: ${name}=${JSON.stringify(value)}`)
    }
  }
  return { value: null, from: null, tried }
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

export function check(appNodeModules, profileDir) {
  const problems = []
  // 宿主名单：DEFAULT / OPTIONAL / RETIRED 在 0.2.1 前后分别住在 official-bundles 与 app-boot。
  const defaults = firstList(HOST_BUNDLE_SOURCES, ['DEFAULT_PROFILE_BUNDLES'], appNodeModules)
  const optional = firstList(HOST_BUNDLE_SOURCES, ['OPTIONAL_BUNDLES'], appNodeModules)
  // 退役名单从 0.2.1 才有：老 pin 没有这个常量 → 空数组，语义不变。
  const retired = firstList(HOST_BUNDLE_SOURCES, ['RETIRED_BUNDLES'], appNodeModules)
  // 内置名单：新上游叫 HIDDEN_BUNDLES（在 official-bundles / client.js 都可能），旧上游叫 BUILTIN_PROFILE_BUNDLES（在 client.js）。
  const builtin = firstList([...HOST_BUNDLE_SOURCES, CLIENT_BUNDLE_SOURCE], BUILTIN_NAMES, appNodeModules)

  if (defaults.value === null || optional.value === null || builtin.value === null) {
    console.error('check-bundles: 名单解析失败或为空 —— 上游改了这几行，请人工核对本脚本的候选源：')
    for (const [label, result] of [['DEFAULT_PROFILE_BUNDLES', defaults], ['OPTIONAL_BUNDLES', optional], ['HIDDEN/BUILTIN', builtin], ['RETIRED_BUNDLES', retired]]) {
      console.error(`  ${label} = ${JSON.stringify(result.value)}${result.from === null ? '' : '  （取自 ' + result.from + '）'}`)
      if (result.value === null) for (const line of result.tried) console.error(`    试过 ${line}`)
    }
    return 2
  }

  const defaultsList = defaults.value
  const optionalList = optional.value
  const builtinList = builtin.value
  const retiredList = retired.value ?? []
  console.log(`check-bundles: 从已部署包里解析出 DEFAULT=${defaultsList.length} OPTIONAL=${optionalList.length} BUILTIN=${builtinList.length}`)
  console.log(`  DEFAULT : ${defaultsList.join(', ')}  ← ${defaults.from}`)
  console.log(`  OPTIONAL: ${optionalList.join(', ')}  ← ${optional.from}`)
  console.log(`  BUILTIN : ${builtinList.join(', ')}  ← ${builtin.from}`)
  if (retiredList.length > 0) console.log(`  RETIRED : ${retiredList.join(', ')}  ← 上游已退役，不再要求随包（${retired.from}）`)

  console.log('')
  console.log('随包必须撑住的（DEFAULT ∪ OPTIONAL ∪ BUILTIN）：')
  const advertised = [...new Set([...defaultsList, ...optionalList, ...builtinList])]
  const retiredSet = new Set(retiredList)
  for (const name of advertised) {
    if (retiredSet.has(name)) {
      // 上游名单里还留着它、但已退役：不要求随包，只提示（profile 里的同名条目由 boot 自己摘掉）。
      console.log(`  – ${name}  ← 上游已退役（RETIRED_BUNDLES），不要求随包`)
      continue
    }
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
    const optionalSet = new Set(optionalList)
    console.log('')
    console.log(`profile 声明的 bundle（${declared.length} 个）与它们的兜底来源：`)
    for (const name of declared) {
      if (retiredSet.has(name)) {
        console.log(`  – ${name}  ← 上游已退役（RETIRED_BUNDLES）：加载 profile 时自动摘掉，不算问题`)
        continue
      }
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

/** 造一棵假树：`files` 是 rel → 内容的映射。 */
export function makeTree(prefix, files) {
  const base = mkdtempSync(join(tmpdir(), `dsh-bundles-${prefix}-`))
  const nm = join(base, 'node_modules')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(nm, rel, '..'), { recursive: true })
    writeFileSync(join(nm, rel), text)
  }
  return { base, nm }
}

/** 用一个假树证明"缺 bundle 会说 ✗ 而不是静默通过"。 */
export function selfTest() {
  const boot = 'const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];\nconst OPTIONAL_BUNDLES = [\n\t"@deepseek-ai/dsh-experimental-lost"\n];\n'
  const client = 'const BUILTIN_PROFILE_BUNDLES = new Set([\n\t"@deepseek-ai/dsh-base"\n]);\n'
  // 故意只装 base，让 experimental-lost 缺位
  const { base, nm } = makeTree('legacy', {
    '@deepseek-ai/dsh-app-boot/lib/index.js': boot,
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': client,
    '@deepseek-ai/dsh-base/package.json': '{"name":"@deepseek-ai/dsh-base","version":"0.0.0"}',
  })
  const profile = join(base, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-lost'] } },
  }))

  console.log('== self-test：旧布局（名单在 app-boot / client），缺一个可选 bundle ==')
  const code = check(nm, profile)
  rmSync(base, { recursive: true, force: true })
  if (code !== 1) {
    console.error(`self-test: ✗ 期望返回 1，实际 ${code}`)
    return 1
  }
  console.log('self-test: ✓ 缺 bundle 时返回 1（不是静默通过）')

  // 退役 bundle：profile 里还声明着、上游已退役且不随包 —— 必须判成无事（boot 会自己摘掉），
  // 且退役名单带类型标注（`const RETIRED_BUNDLES: ReadonlySet<string> = new Set([...])`）也要能解析。
  const legacy2 = makeTree('retired', {
    '@deepseek-ai/dsh-app-boot/lib/index.js': 'const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];\nconst OPTIONAL_BUNDLES = [\n\t"@deepseek-ai/dsh-base"\n];\nconst RETIRED_BUNDLES: ReadonlySet<string> = new Set([\n\t"@deepseek-ai/dsh-experimental-schedule-bundle"\n]);\n',
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': client,
    '@deepseek-ai/dsh-base/package.json': '{"name":"@deepseek-ai/dsh-base","version":"0.0.0"}',
  })
  const profile2 = join(legacy2.base, 'profiles', 'web')
  mkdirSync(profile2, { recursive: true })
  writeFileSync(join(profile2, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-schedule-bundle'] } },
  }))

  console.log('')
  console.log('== self-test：退役 bundle 仍写在 profile 里，看它是否不报错 ==')
  const retiredCode = check(legacy2.nm, profile2)
  rmSync(legacy2.base, { recursive: true, force: true })
  if (retiredCode !== 0) {
    console.error(`self-test: ✗ 期望退役 bundle 返回 0，实际 ${retiredCode}`)
    return 1
  }
  console.log('self-test: ✓ 退役 bundle 不再算问题')

  // 0.2.1 起的新布局：名单搬进 @deepseek-ai/dsh-official-bundles，客户端那份改名 HIDDEN_BUNDLES，
  // app-boot 里已经什么都不剩。这是让 portable job 挂掉的那次搬家 —— 必须能认出新位置。
  const official = [
    'const RETIRED_BUNDLES: ReadonlySet<string> = new Set([',
    '  "@deepseek-ai/dsh-experimental-schedule-bundle",',
    '])',
    'const DEFAULT_PROFILE_BUNDLES: readonly string[] = ["@deepseek-ai/dsh-base"]',
    'const OPTIONAL_BUNDLES: readonly string[] = [',
    '  "@deepseek-ai/dsh-experimental-lost",',
    ']',
    'const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([',
    '  "@deepseek-ai/dsh-base",',
    '])',
  ].join('\n') + '\n'
  const moved = makeTree('official', {
    '@deepseek-ai/dsh-official-bundles/lib/index.js': official,
    '@deepseek-ai/dsh-app-boot/lib/index.js': 'import { DEFAULT_PROFILE_BUNDLES } from "@deepseek-ai/dsh-official-bundles"\nexport { DEFAULT_PROFILE_BUNDLES }\n',
    '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js': 'import { HIDDEN_BUNDLES } from "@deepseek-ai/dsh-official-bundles"\nconsole.log(HIDDEN_BUNDLES)\n',
    '@deepseek-ai/dsh-base/package.json': '{"name":"@deepseek-ai/dsh-base","version":"0.0.0"}',
  })
  const profile3 = join(moved.base, 'profiles', 'web')
  mkdirSync(profile3, { recursive: true })
  writeFileSync(join(profile3, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))

  console.log('')
  console.log('== self-test：0.2.1 新布局（名单搬到 official-bundles），缺一个可选 bundle ==')
  const movedCode = check(moved.nm, profile3)
  rmSync(moved.base, { recursive: true, force: true })
  if (movedCode !== 1) {
    console.error(`self-test: ✗ 期望返回 1（experimental-lost 缺位），实际 ${movedCode}`)
    return 1
  }
  console.log('self-test: ✓ 名单搬到新包后仍然认得出来')
  return 0
}

if (import.meta.main) {
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
}
