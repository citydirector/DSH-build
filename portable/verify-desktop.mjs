// verify-desktop.mjs —— 对组装好的绿色桌面包做静态验收（S1 验收清单的自动化部分）。
//
// 检查：
//   1. 入口与标记文件：DeepSeek Harness.exe / portable.flag / VERSION / update.json
//   2. 无更新来源：resources 下不得有 app-update.yml；asar 内 package.json 不得含 dshMandatoryUpdatePolicy
//   3. 迁移器：resources/dsh-build/migrate-sessions-v4.mjs 存在
//   4. 补丁在产物里：运行时段 tarball 内 dsh-workflow-ptc/lib/index.js 可解析、白名单含 instruction-hint
//   5. 插件面：computer-use / browser-use 的包在运行时段 dsh/node_modules 里，原生二进制已 unpack
//   6. 数据面：产物不含 data/
//
// 用法: node verify-desktop.mjs [--dir <staged package>]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
// 平台原生包名带工具链后缀（-msvc / -gnu），共用补丁脚本里的词表匹配，免得两处各写一套
import { matchesPlatformName } from './patch-desktop-computer-use.mjs'
// browser-use 那族要断言的包名同样从补丁脚本取（换提供方时只改补丁脚本的 PROVIDER 一处）
import { RUNTIME_PACKAGES as BROWSER_USE_PACKAGES } from './patch-desktop-browser-use.mjs'
// asar 格式与重打包工具共用同一份实现（头部 pickle / 数据区起点 / 块间无对齐填充）
import { parseAsarBuffer, readAsarFile, walkAsarEntries } from './asar-format.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function main() {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: join(HERE, 'build', 'dsh-desktop') } } })
  const stage = resolve(values.dir)
  const problems = []
  const notes = []
  const check = (ok, label, detail = '') => { if (ok) notes.push(`ok   ${label}`); else problems.push(`FAIL ${label}${detail === '' ? '' : ' — ' + detail}`) }

  check(existsSync(join(stage, 'DeepSeek Harness.exe')), 'entry executable')
  check(existsSync(join(stage, 'portable.flag')), 'portable.flag')
  check(existsSync(join(stage, 'VERSION')), 'VERSION')
  const manifestPath = join(stage, 'update.json')
  check(existsSync(manifestPath), 'update.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check(manifest.kind === 'desktop', 'update.json kind', String(manifest.kind))
    check(manifest.assetPrefix === 'dsh-desktop-win64', 'update.json assetPrefix', String(manifest.assetPrefix))
    check(Array.isArray(manifest.preserve) && manifest.preserve.includes('data'), 'update.json preserves data')
  }

  const resources = join(stage, 'resources')
  check(!existsSync(join(resources, 'app-update.yml')), 'no electron-updater feed (app-update.yml)')
  const asarPath = join(resources, 'app.asar')
  if (existsSync(asarPath)) {
    const buffer = readFileSync(asarPath)
    try {
      const packaged = JSON.parse(readAsarFile(buffer, 'package.json').toString('utf8'))
      check(!('dshMandatoryUpdatePolicy' in packaged), 'no embedded Platform policy in packaged manifest')
      check(typeof packaged.version === 'string', 'packaged version', String(packaged.version))
    } catch (error) { problems.push(`FAIL asar manifest — ${error instanceof Error ? error.message : String(error)}`) }
  } else problems.push('FAIL resources/app.asar missing')

  const migrator = join(resources, 'dsh-build', 'migrate-sessions-v4.mjs')
  check(existsSync(migrator), 'bundled session migrator')

  // 运行时段补丁：dsh 运行时的 JS 在 asar 内（asar.unpacked 只放原生二进制）
  const runtimeEntries = [
    ['dsh-util-values', 'dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js'],
    ['dsh-workflow-ptc', 'dsh/node_modules/@deepseek-ai/dsh-workflow-ptc/lib/index.js'],
    ['dsh-session-format-v2-to-v3', 'dsh/node_modules/@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js'],
  ]
  const unpackedRoot = join(resources, 'app.asar.unpacked')
  for (const [name, entry] of runtimeEntries) {
    let source
    const onDisk = join(unpackedRoot, entry)
    try {
      source = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : readAsarFile(readFileSync(asarPath), entry).toString('utf8')
    } catch (error) {
      problems.push(`FAIL runtime ${name} — ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (name === 'dsh-util-values') {
      // 补丁 1 的源码层形态：明文正则。
      // 上游可能自行修好（改为两次 Function.prototype.toString 互比），此时文件里
      // 既无 '[native code]' 也无补丁标记 —— 属"不需要补丁"，不是失败。
      // 不变式：只要还带 '[native code]' 特征，就必须已经带上补丁标记。
      if (source.includes('[native code]')) {
        check(source.includes('replace(/\\s+/g, " ")'), 'runtime: native-code guard patched (source form)')
      } else {
        notes.push('skip runtime: native-code guard — 上游已无 [native code] 特征，补丁 1 不再适用')
      }
    } else if (name === 'dsh-workflow-ptc') {
      // 补丁 1 在 guest 源里的形态：位于字符串字面量内，转义成 \\s+ 与 \" \"
      check(source.includes('replace(/\\\\s+/g, \\" \\")'), 'runtime: guest source guard patched (escaped inside the literal)')
    } else {
      // 补丁 2：v2->v3 的 SOURCE_KINDS 白名单必须含历史 kind
      // 引号两侧皆认（["']）：断言的是不变式（白名单里有这两个 kind），不钉死引号形态。
      const kinds = /SOURCE_KINDS = new Set\(\[([\s\S]{0,400}?)\]\)/.exec(source)
      const kindsHas = (name) => kinds !== null && new RegExp('["\']' + name + '["\']').test(kinds[1])
      check(kindsHas('user') && kindsHas('instruction-hint'), 'runtime: whitelist reads user + instruction-hint')
    }
  }
  // P4：会话写锁名必须由 canonical 路径派生，否则经软链/联接点到达的同一文件会有两把锁。
  const lockEntry = 'dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
  try {
    const lockSource = existsSync(join(unpackedRoot, lockEntry))
      ? readFileSync(join(unpackedRoot, lockEntry), 'utf8')
      : readAsarFile(readFileSync(asarPath), lockEntry).toString('utf8')
    check(lockSource.includes('canonicalLockPath'), 'runtime: session lock name hashes the canonical path')
  } catch (error) {
    problems.push(`FAIL session lock surface — ${error instanceof Error ? error.message : String(error)}`)
  }

  // 源码补丁（patch-windows-acl-runner-console）：受限子进程与 runner 共享控制台，而 Electron 是
  // GUI 子系统、永远不持有控制台 → runner 必须自备一个，否则桌面端每条受限命令都在 DLL 初始化
  // 阶段以 0xC0000142 静默死亡。
  const aclRunnerEntry = 'dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js'
  try {
    const aclRunnerSource = existsSync(join(unpackedRoot, aclRunnerEntry))
      ? readFileSync(join(unpackedRoot, aclRunnerEntry), 'utf8')
      : readAsarFile(readFileSync(asarPath), aclRunnerEntry).toString('utf8')
    check(aclRunnerSource.includes('ensureSharedConsole'), 'runtime: windows-acl runner acquires a shared console')
    check(aclRunnerSource.includes('STATUS_DLL_INIT_FAILED'), 'runtime: 0xC0000142 classified as a runner failure')
  } catch (error) {
    problems.push(`FAIL windows-acl runner surface — ${error instanceof Error ? error.message : String(error)}`)
  }

  // 便携引导：打包进 asar 的 main.js 必须带我们的 bootstrap
  try {
    const mainSource = readAsarFile(readFileSync(asarPath), 'lib/main.js').toString('utf8')
    check(mainSource.includes('portable.flag'), 'portable bootstrap compiled into lib/main.js')
    check(/session-v4-|MIGRATION_MARKER|migrate-sessions-v4\.mjs/.test(mainSource), 'session-migration hook compiled into lib/main.js')
  } catch (error) {
    problems.push(`FAIL lib/main.js — ${error instanceof Error ? error.message : String(error)}`)
  }

  // computer-use：注册表 + 提供方 + SDK + 平台原生包必须打进 asar，原生 .node 必须在
  // app.asar.unpacked（electron 不能从 asar 里加载原生模块）。打包之后补不进去，只能靠打包前的
  // 依赖声明带上。包名一律用词表匹配（工具链后缀 -msvc / -gnu 会变，写死会假失败）；失败信息里
  // 带上"实际打进了哪些包"和"asar 里有没有 .node"，这样它自己就能指出是没打包还是没 unpack。
  try {
    const buffer = readFileSync(asarPath)
    const { header } = parseAsarBuffer(buffer)
    const asarPaths = walkAsarEntries(header).map(({ path }) => path)

    // 关键：必须在**运行时那棵树**（dsh/node_modules）里，而不是 asar 根的 node_modules。
    // asar 里是两棵树 —— 根那棵给 Electron 主程序，dsh/ 那棵给 harness；profile 的插件行是在
    // dsh/ 里解析的。第一版就是把依赖声明在 apps/desktop 上（落到根那棵），行找不到包 → 静默
    // 不加载（提供方不激活、工具不注册，不报错也不崩）。这里按位置断言，把那个坑钉住。
    const runtimePaths = asarPaths.filter((path) => path.startsWith('dsh/node_modules/'))
    for (const suffix of [
      '@deepseek-ai/dsh-computer-use/package.json',
      '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native/package.json',
      '@trycua/cua-driver/package.json',
    ]) {
      const inRuntime = runtimePaths.some((path) => path.endsWith(suffix))
      const elsewhere = asarPaths.filter((path) => path.endsWith(suffix) && !path.startsWith('dsh/node_modules/'))
      check(inRuntime, 'computer-use: ' + suffix + ' in 运行时树 dsh/node_modules',
        elsewhere.length > 0 ? '只出现在别处（' + elsewhere[0] + '）→ 插件行解析不到' : '两棵树里都没有')
    }

    /** 收集运行时树里某个前缀下的包名（不含路径）。 */
    const packagesUnder = (prefix) => [...new Set(runtimePaths
      .filter((path) => path.includes(prefix) && path.endsWith('/package.json'))
      .map((path) => path.slice(path.indexOf(prefix), path.length - '/package.json'.length)))]
    for (const [label, prefix] of [['SDK', '@trycua/cua-driver-'], ['ubjs', '@ubjs/']]) {
      const found = packagesUnder(prefix).filter((name) => matchesPlatformName(name))
      check(found.length > 0, `computer-use: ${label} 平台原生包 in 运行时树`,
        '运行时树里打进去的：' + (packagesUnder(prefix).join(', ') || '（一个都没有）'))
    }

    const nativeFiles = []
    const walkUnpacked = (dir, depth) => {
      if (depth > 6) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walkUnpacked(path, depth + 1)
        else if (entry.name.endsWith('.node')) nativeFiles.push(path)
      }
    }
    if (existsSync(unpackedRoot)) walkUnpacked(unpackedRoot, 0)
    const cuaNative = nativeFiles.filter((path) => /cua|ubjs/u.test(path))
    const asarNodeFiles = asarPaths.filter((path) => path.endsWith('.node'))
    check(cuaNative.length > 0, 'computer-use: Cua Driver 原生二进制已 unpack', cuaNative.length > 0 ? ''
      : asarNodeFiles.length > 0
        ? `asar 里有 ${asarNodeFiles.length} 个 .node 却没 unpack（需要 asarUnpack）：` + asarNodeFiles.slice(0, 3).join(', ')
        : 'asar 与 app.asar.unpacked 里都没有 .node（原生包没被打进闭包）')

    // 光解 .node/.dll 不够：SDK 的**JS** 也必须在真实路径上。它靠 import.meta.url 定位原生库，
    // 再交给原生代码（Rust LoadLibrary）打开 —— 原生代码不走 Electron 的 asar 垫片，JS 留在 asar
    // 里的结果是拿到 …/app.asar/… 打不开，提供方 apply 抛错、只写 stderr、表现成"静默不激活"。
    for (const rel of [
      'dsh/node_modules/@trycua/cua-driver/dist/index.js',
      'dsh/node_modules/@trycua/cua-driver/dist/native/cua_driver_contract-ffi.js',
    ]) {
      const unpacked = join(unpackedRoot, rel)
      const inAsarOnly = existsSync(join(stage, 'resources/app.asar')) && asarPaths.includes(rel)
      check(existsSync(unpacked), 'computer-use: ' + rel.replace('dsh/node_modules/', '') + ' 已 unpack',
        inAsarOnly ? '只留在 asar 里 → import.meta.url 会指向 app.asar，原生库打不开' : '既不在 unpacked 也不在 asar')
    }
    // 原生库在 asar 里打不开（实测 os error 126）——所以要确认 @ubjs 的路径解析带上了 asar→unpacked 映射。
    const ubjsLib = join(unpackedRoot, 'dsh/node_modules/@ubjs/node/typescript/dist/resolve-lib.js')
    const ubjsText = existsSync(ubjsLib) ? readFileSync(ubjsLib, 'utf8') : ''
    check(ubjsText.includes('dsh-build asar fix'), 'computer-use: @ubjs resolveLibPath 带 asar→unpacked 映射',
      ubjsText === '' ? 'app.asar.unpacked 里没有 resolve-lib.js（@ubjs 没整树解出来？）' : '没打上补丁 → 原生库会以 os error 126 失败')
  } catch (error) {
    problems.push(`FAIL computer-use surface — ${error instanceof Error ? error.message : String(error)}`)
  }

  // browser-use：注册表 + 运行时 + 选定提供方必须在**运行时那棵树**（dsh/node_modules）里 ——
  // 理由同 computer-use（profile 的插件行在 dsh/ 里解析；声明落在 asar 根那棵会让行找不到包、
  // 静默不加载）。这一族全是纯 JS，没有原生模块，所以不需要 unpack 与原生库路径断言。
  try {
    const buffer = readFileSync(asarPath)
    const { header } = parseAsarBuffer(buffer)
    const asarPaths = walkAsarEntries(header).map(({ path }) => path)
    const runtimePaths = asarPaths.filter((path) => path.startsWith('dsh/node_modules/'))
    const requireInRuntime = (suffix, label) => {
      const inRuntime = runtimePaths.some((path) => path.endsWith(suffix))
      const elsewhere = asarPaths.filter((path) => path.endsWith(suffix) && !path.startsWith('dsh/node_modules/'))
      check(inRuntime, 'browser-use: ' + label + ' in 运行时树 dsh/node_modules',
        elsewhere.length > 0 ? '只出现在别处（' + elsewhere[0] + '）→ 插件行解析不到' : '两棵树里都没有')
    }
    for (const name of BROWSER_USE_PACKAGES) requireInRuntime(name + '/package.json', name)

    // 提供方自己的 registry 依赖（chrome-devtools-mcp 之类）也得在树里，否则提供方激活时 import
    // 失败。从产物里那份提供方清单读出来逐个断言 —— 换提供方时这里不用改。
    const provider = BROWSER_USE_PACKAGES[BROWSER_USE_PACKAGES.length - 1]
    const providerEntry = 'dsh/node_modules/' + provider + '/package.json'
    if (!asarPaths.includes(providerEntry)) {
      problems.push('FAIL browser-use: 读不到产物里 ' + provider + ' 的清单，无法核对它的 registry 依赖')
    } else {
      const declared = JSON.parse(readAsarFile(buffer, providerEntry).toString('utf8'))
      const deps = Object.keys({ ...declared.dependencies, ...declared.optionalDependencies })
        .filter((name) => !name.startsWith('@deepseek-ai/'))
      if (deps.length === 0) {
        notes.push('skip browser-use: ' + provider + ' 没有 registry 依赖')
      }
      for (const name of deps) requireInRuntime(name + '/package.json', provider + ' 的依赖 ' + name)
    }
  } catch (error) {
    problems.push(`FAIL browser-use surface — ${error instanceof Error ? error.message : String(error)}`)
  }

  check(!existsSync(join(stage, 'data')), 'ships no data/ (DSH_HOME is created on first run)')

  console.log(notes.join('\n'))
  console.log('')
  if (problems.length === 0) console.log('verify-desktop: 全部通过')
  else console.log('verify-desktop: 失败项\n' + problems.join('\n'))
  process.exit(problems.length === 0 ? 0 : 1)
}

if (import.meta.main) main()
