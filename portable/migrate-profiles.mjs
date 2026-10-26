// portable/migrate-profiles.mjs —— 启动期把用户 profile 的 cordis.patch.yml 迁到当前运行时的口径上。
//
// 为什么在这里，而不是 update.exe：
//   更新器把「覆盖程序」和「改用户配置」绑成一件事，结果两条路都可能断 ——
//   update 的插件预检只在 check 成功时才写 apply-update.cmd，只要 check 因任何原因没跑成
//   （退出码既非 0 也非 3、脚本不在位、plan 写不出来），整段迁移就被静默跳过：程序换成新版、
//   配置还是旧口径，于是新版一起就崩（预设挂不上 → 建会话失败）。而且更新前改配置更危险：
//   用户中途中止，配置已按新版改完、程序还是旧的，正在跑的那一份当场坏掉。
//   改成启动期做，就没有「先有鸡还是先有蛋」：程序已经就位，跑的一定是它的口径；
//   一次启动跑完，不需要连跑两次更新器。
//
// 与会话代际迁移（app/migrate-sessions-v4.mjs）是同一套做法：
//   便携版由 dsh-launcher.cs 的 RunProfileMigration 调起，桌面版由 dsh-portable-bootstrap.ts
//   的 migrateProfilesOnce 用 ELECTRON_RUN_AS_NODE 调起；两者都按 VERSION 一次性打点。
//
// 用法：
//   node migrate-profiles.mjs --home <DSH_HOME> --runtime <运行时目录> [--profile <名>]... [--force] [--quiet]
//
// 退出码：
//   0  无需迁移，或全部迁移完成（含「改了但读不完全」的警告）
//   1  至少一个 profile 迁移抛错（配置保持原样，调用方只记日志，绝不拦启动）
//   2  参数不全（调用方传错了，不是用户的问题）
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, migrateProfile } from './lib/profile-compat.mjs'

const USAGE = '用法：migrate-profiles.mjs --home <DSH_HOME> --runtime <运行时目录> [--profile <名>]... [--force] [--quiet]'

/** 解析命令行。认不出的参数直接报错 —— 猜错路径会改错文件。 */
export function parseArgs(argv) {
  const options = { home: undefined, runtime: undefined, profiles: [], force: false, quiet: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--force') { options.force = true; continue }
    if (argument === '--quiet') { options.quiet = true; continue }
    if (argument === '--home' || argument === '--runtime' || argument === '--profile') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(argument + ' 缺少取值。' + USAGE)
      index++
      if (argument === '--home') options.home = value
      else if (argument === '--runtime') options.runtime = value
      else options.profiles.push(value)
      continue
    }
    throw new Error('认不出的参数 ' + argument + '。' + USAGE)
  }
  if (options.home === undefined) throw new Error('缺少 --home。' + USAGE)
  if (options.runtime === undefined) throw new Error('缺少 --runtime。' + USAGE)
  return options
}

/**
 * 列出 home 下所有带 cordis.patch.yml 的 profile。
 * 不看 package.json：配置坏掉的 profile 恰恰最需要迁移，而它可能连 package.json 都读不动。
 */
export function listProfileDirectories(home, only) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  const wanted = only === undefined || only.length === 0 ? undefined : new Set(only)
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && (wanted === undefined || wanted.has(entry.name)))
    .map(entry => ({ name: entry.name, directory: join(root, entry.name) }))
    .filter(profile => existsSync(join(profile.directory, 'cordis.patch.yml')))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 迁移全部（或指定的）profile。
 * 单个 profile 抛错只降级成一条 error，继续迁下一个 —— 一个坏掉的 profile 不该带走其它的。
 * @returns {{results: object[], failed: number}}
 */
export function migrateAllProfiles({ home, runtime, profiles, log = () => {} }) {
  const runtime$ = createRuntime(runtime)
  const results = []
  let failed = 0
  for (const profile of listProfileDirectories(home, profiles)) {
    try {
      const result = migrateProfile(profile.directory, runtime$)
      results.push({ profile: profile.name, ...result })
      for (const change of result.changes) log('  [' + profile.name + '] ' + change.detail)
      for (const warning of result.warnings) log('  [' + profile.name + '] 未处理：' + warning.detail)
    } catch (error) {
      failed++
      const detail = error instanceof Error ? error.message : String(error)
      results.push({ profile: profile.name, changed: false, changes: [], warnings: [], error: detail })
      log('  [' + profile.name + '] 迁移失败，配置保持原样：' + detail)
    }
  }
  return { results, failed }
}

export function main(argv = process.argv.slice(2), log = console.log) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  const home = resolve(options.home)
  const runtime = resolve(options.runtime)
  if (!existsSync(join(home, 'profiles'))) {
    if (!options.quiet) log('没有 profiles 目录（' + home + '），跳过配置迁移。')
    return 0
  }
  if (!existsSync(runtime)) {
    console.error('运行时目录不存在：' + runtime + '，跳过配置迁移。')
    return 0
  }
  // createRuntime 自己会在运行时里 resolve 包；这里先兜一层，让它抛错时不至于连 profile 名都报不出来。
  let outcome
  try {
    outcome = migrateAllProfiles({ home, runtime, profiles: options.profiles, log })
  } catch (error) {
    console.error('配置迁移未执行：' + (error instanceof Error ? error.message : String(error)))
    return 0
  }
  const changed = outcome.results.filter(item => item.changed).length
  const warned = outcome.results.filter(item => item.warnings.length > 0).length
  if (!options.quiet && (changed > 0 || warned > 0)) {
    log('配置迁移：' + changed + ' 个 profile 已按当前运行时改写、' + warned + ' 个有未处理项。')
  }
  return outcome.failed > 0 ? 1 : 0
}

// 只有真被当脚本跑时才执行 —— 单测里 import 本文件不该动盘。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main()
}
