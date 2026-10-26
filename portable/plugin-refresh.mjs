#!/usr/bin/env node
// 插件随版本刷新：update.exe 在「覆盖前」检查、在「覆盖后」升级 profile 里的插件。
//
// 为什么需要：插件装在 data/profiles/<profile>/（自己的 package.json + pnpm-lock），更新器保留 data/，
// 所以 dsh 升级后插件仍停在旧版本；而上游启动时按 semver 校验插件对 @deepseek-ai/dsh* 的 peer
// （app-boot 的 plugin-compatibility），官方插件多为精确钉版 → 每次升 dsh 都会被判不兼容。
//
// 本脚本只做「找版本」与「按顺序调用官方 CLI」两件事：
//   - 兼容判定沿用上游规则（只看 @deepseek-ai/dsh 与 @deepseek-ai/dsh-*；includePrerelease；
//     workspace:^/~/* 视为当前运行时），semver 取自**新运行时自己的** node_modules；
//   - 真正的安装走 `dsh plugin --profile <p> add <name>@<version>`，上游在那里做兼容门禁，
//     不兼容就把 package.json / pnpm-lock.yaml 回滚，本脚本不碰 profile 里的任何文件。
//
// 用法：
//   node plugin-refresh.mjs check --home <DSH_HOME> --runtime <运行时目录> --out <plan.json> [--all]
//     <运行时目录>：便携版 app/（即 @deepseek-ai/dsh 包根），桌面版 resources/app.asar/dsh。
//     默认只为「对新运行时不兼容」的插件找升级；--all 也把兼容插件升到最新兼容版（手动更新）。
//     退出码：0 = 没有被卡住的插件；3 = 有插件找不到兼容版本；1 = 检查本身失败。
//   node plugin-refresh.mjs apply --plan <plan.json> -- <dsh CLI 命令...>
//     对计划里每个 upgrade 依次执行 `<CLI> plugin --profile <p> add <name>@<target>`。
//     退出码：0 = 全部成功或无事可做；1 = 有升级失败（上游已回滚该插件）。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

/** 与上游 evaluatePluginCompatibility 相同的取舍：哪些 peer 名字属于 dsh。 */
export function isDshPeer(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * 一份 manifest 对给定运行时不满足的 dsh peer。
 * @returns 不满足的 { name: range }；全部满足时为空对象。
 */
export function unmetDshPeers(manifest, runtimeVersion, semver) {
  const unmet = {}
  const peers = manifest?.peerDependencies
  if (peers === null || typeof peers !== 'object') return unmet
  for (const [name, range] of Object.entries(peers)) {
    if (!isDshPeer(name) || typeof range !== 'string') continue
    const requirement = WORKSPACE_RANGES.has(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      unmet[name] = range
    }
  }
  return unmet
}

/** 依赖声明是不是来自 registry（版本号、范围、dist-tag、npm: 别名之外的一律不管）。 */
export function isRegistrySpec(spec) {
  if (typeof spec !== 'string') return false
  if (/^(?:workspace|file|link|portal|git|git\+[a-z]+|github|gitlab|bitbucket|https?|npm):/iu.test(spec)) return false
  if (/^[./~]|^[a-z]:[\\/]/iu.test(spec)) return false // 路径
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/u.test(spec)) return false // user/repo 简写
  return true
}

/**
 * 在 registry 给出的版本里挑升级目标。
 * 候选：比已装版本新、未弃用、dsh peer 全部满足。优先 dist-tags.latest，其次最高正式版，再次最高预发布。
 * @returns 目标版本；没有合适候选时为 undefined。
 */
export function pickTarget(packument, installed, runtimeVersion, semver) {
  const versions = packument?.versions ?? {}
  const candidates = Object.keys(versions).filter((version) => {
    const manifest = versions[version]
    if (semver.valid(version) === null || !semver.gt(version, installed)) return false
    if (manifest?.deprecated) return false
    return Object.keys(unmetDshPeers(manifest, runtimeVersion, semver)).length === 0
  })
  if (candidates.length === 0) return undefined
  const latest = packument?.['dist-tags']?.latest
  if (typeof latest === 'string' && candidates.includes(latest)) return latest
  const sorted = candidates.sort(semver.rcompare)
  return sorted.find((version) => semver.prerelease(version) === null) ?? sorted[0]
}

/** 把 .npmrc 文本里的 registry 设置读出来：{ default, scopes: { '@x': url } }。 */
export function parseNpmrc(text) {
  const result = { scopes: {} }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^(@[^:\s]+:)?registry\s*=\s*(.+)$/u.exec(line)
    if (match === null) continue
    const url = match[2].trim().replace(/^["']|["']$/gu, '')
    if (match[1] === undefined) result.default ??= url
    else result.scopes[match[1].slice(0, -1)] ??= url
  }
  return result
}

/** 按 pnpm 的优先级解析某个包该问哪个 registry：环境变量 > profile .npmrc > 用户 .npmrc > npmjs。 */
export function registryFor(name, sources) {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined
  for (const source of sources) {
    if (scope !== undefined && source.scopes?.[scope]) return withSlash(source.scopes[scope])
    if (source.default) return withSlash(source.default)
  }
  return DEFAULT_REGISTRY
}

function withSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** profile 自己的 compatibility.json（exact name@version → exact dsh 版本列表），读不了就当没有。 */
function readExemptions(profileDir) {
  try {
    const value = readJson(join(profileDir, 'compatibility.json'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** 列出 home/profiles 下有 package.json 的 profile。 */
export function listProfiles(home) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'package.json')))
    .map(entry => ({ name: entry.name, dir: join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 计算一份升级计划。
 * @param options.home DSH_HOME
 * @param options.runtimeVersion 新运行时版本
 * @param options.semver 新运行时的 semver
 * @param options.fetchPackument (name, registry) => Promise<packument>
 * @param options.all 兼容插件也升级到最新兼容版
 * @param options.env 环境变量（取 npm_config_registry）
 * @param options.userNpmrc 用户级 .npmrc 文本
 */
export async function buildPlan({ home, runtimeVersion, semver, fetchPackument, all = false, env = {}, userNpmrc = '' }) {
  const profiles = []
  for (const profile of listProfiles(home)) {
    const manifest = readJson(join(profile.dir, 'package.json'))
    const dependencies = manifest.dependencies ?? {}
    const exemptions = readExemptions(profile.dir)
    const sources = [
      env.npm_config_registry ? { default: env.npm_config_registry, scopes: {} } : { scopes: {} },
      parseNpmrc(readText(join(profile.dir, '.npmrc'))),
      parseNpmrc(userNpmrc),
    ]
    const plugins = []
    for (const [name, spec] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
      const entry = { name, spec }
      plugins.push(entry)
      const installedPath = join(profile.dir, 'node_modules', ...name.split('/'), 'package.json')
      if (!existsSync(installedPath)) { entry.status = 'skip'; entry.reason = '未安装'; continue }
      let installed
      try { installed = readJson(installedPath) } catch { entry.status = 'skip'; entry.reason = 'package.json 无法读取'; continue }
      entry.installed = installed.version
      const unmet = unmetDshPeers(installed, runtimeVersion, semver)
      const compatible = Object.keys(unmet).length === 0
      if (!compatible) entry.peers = unmet
      if (compatible && !all) { entry.status = 'ok'; continue }
      if (!isRegistrySpec(spec)) {
        entry.status = compatible ? 'ok' : 'blocked'
        entry.reason = '非 registry 来源，需手动处理'
        continue
      }
      if (!compatible && exemptions[`${name}@${installed.version}`]?.includes?.(runtimeVersion)) {
        entry.status = 'exempted'
        continue
      }
      let packument
      try {
        packument = await fetchPackument(name, registryFor(name, sources))
      } catch (error) {
        entry.status = compatible ? 'ok' : 'unknown'
        entry.reason = `registry 查询失败：${error instanceof Error ? error.message : String(error)}`
        continue
      }
      const target = semver.valid(installed.version) === null ? undefined : pickTarget(packument, installed.version, runtimeVersion, semver)
      if (target !== undefined) { entry.status = 'upgrade'; entry.target = target }
      else if (compatible) entry.status = 'ok'
      else { entry.status = 'blocked'; entry.reason = '没有兼容新运行时的版本' }
    }
    profiles.push({ profile: profile.name, plugins })
  }
  return { runtimeVersion, all, profiles }
}

const STATUS_TEXT = {
  ok: '兼容',
  upgrade: '将升级',
  blocked: '不兼容',
  exempted: '已豁免',
  unknown: '未能确认',
  skip: '跳过',
}

/** 给人看的报告；没有插件时返回空字符串。 */
export function formatPlan(plan) {
  const lines = []
  for (const { profile, plugins } of plan.profiles) {
    if (plugins.length === 0) continue
    lines.push(`  [${profile}]`)
    for (const plugin of plugins) {
      const from = plugin.installed ?? plugin.spec
      const to = plugin.status === 'upgrade' ? ` → ${plugin.target}` : ''
      const why = plugin.reason ? `（${plugin.reason}）` : ''
      lines.push(`    ${STATUS_TEXT[plugin.status] ?? plugin.status}  ${plugin.name}@${from}${to}${why}`)
    }
  }
  return lines.length === 0 ? '' : `插件对 dsh ${plan.runtimeVersion} 的兼容情况：\n${lines.join('\n')}`
}

/** 计划里所有待升级项，按 profile 顺序。 */
export function upgradesOf(plan) {
  return plan.profiles.flatMap(({ profile, plugins }) =>
    plugins.filter(plugin => plugin.status === 'upgrade').map(plugin => ({ profile, ...plugin })))
}

export function blockedOf(plan) {
  return plan.profiles.flatMap(({ profile, plugins }) =>
    plugins.filter(plugin => plugin.status === 'blocked').map(plugin => ({ profile, ...plugin })))
}

/**
 * 依次调用 CLI 升级；每个插件单独一次，失败只影响它自己（上游会回滚）。
 * @param run (command, args) => 退出码
 */
export function applyPlan(plan, cli, run) {
  const results = []
  for (const upgrade of upgradesOf(plan)) {
    const args = [...cli.slice(1), 'plugin', '--profile', upgrade.profile, 'add', `${upgrade.name}@${upgrade.target}`]
    const code = run(cli[0], args)
    results.push({ ...upgrade, ok: code === 0, code })
  }
  return results
}

/** 从运行时目录解析 app-boot（取版本）与它所用的 semver。 */
export function loadRuntime(runtimeDirectory) {
  const runtimeDir = resolve(runtimeDirectory)
  const own = join(runtimeDir, 'package.json')
  const anchors = [own, join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')]
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      if (anchor === own && readJson(own).name !== '@deepseek-ai/dsh') continue
      const fromCli = createRequire(anchor)
      const appBootManifest = fromCli.resolve('@deepseek-ai/dsh-app-boot/package.json')
      const version = readJson(appBootManifest).version
      const semver = createRequire(appBootManifest)('semver')
      if (typeof version !== 'string' || semver.valid(version) === null) throw new Error(`运行时版本无效：${String(version)}`)
      return { version, semver }
    } catch (error) {
      throw new Error(`无法从 ${anchor} 解析 dsh 运行时：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`${runtimeDir} 不是 dsh 运行时目录`)
}

async function fetchPackumentHttp(name, registry) {
  const url = `${registry}${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`)
  return response.json()
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command, all: false, cli: [] }
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]
    if (argument === '--') { options.cli = rest.slice(index + 1); break }
    if (argument === '--all') options.all = true
    else if (['--home', '--runtime', '--out', '--plan'].includes(argument)) options[argument.slice(2)] = rest[++index]
    else throw new Error(`未知参数 ${argument}`)
  }
  return options
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.command === 'check') {
    if (!options.home || !options.runtime || !options.out) throw new Error('用法：check --home <dir> --runtime <dir> --out <plan.json> [--all]')
    const { version, semver } = loadRuntime(options.runtime)
    const plan = await buildPlan({
      home: options.home, runtimeVersion: version, semver, fetchPackument: fetchPackumentHttp, all: options.all,
      env: process.env, userNpmrc: readText(join(process.env.USERPROFILE ?? homedir(), '.npmrc')),
    })

    writeFileSync(options.out, `${JSON.stringify(plan, undefined, 2)}\n`)
    const report = formatPlan(plan)
    if (report !== '') console.log(report)
    const blocked = blockedOf(plan)
    if (blocked.length > 0) {
      console.log(`\n${blocked.length} 个插件没有兼容 dsh ${version} 的版本，更新后它们会被停用。`)
      return 3
    }
    return 0
  }
  if (options.command === 'apply') {
    if (!options.plan || options.cli.length === 0) throw new Error('用法：apply --plan <plan.json> -- <dsh CLI 命令...>')
    // profile 配置迁移不在这里：它挂在应用启动期（app/migrate-profiles.mjs，便携版由启动器调起、
    // 桌面版由 dsh-portable-bootstrap.ts 调起）。放在更新器里有过两次失败教训：预检没跑成时整段被
    // 静默跳过（程序换了、配置没换），以及在覆盖前改配置（用户中止更新，旧程序带着新配置崩掉）。
    if (!existsSync(options.plan)) return 0
    const plan = readJson(options.plan)
    if (upgradesOf(plan).length === 0) return 0
    console.log('正在升级插件...')
    const results = applyPlan(plan, options.cli, (command, args) =>
      spawnSync(command, args, { stdio: 'inherit', windowsHide: false }).status ?? 1)
    for (const result of results) {
      console.log(`  ${result.ok ? '已升级' : '失败  '}  [${result.profile}] ${result.name}@${result.installed} → ${result.target}`)
    }
    const failed = results.filter(result => !result.ok)
    if (failed.length > 0) {
      console.log(`\n${failed.length} 个插件升级失败，已保持原样；可稍后运行 update.exe --plugins 重试。`)
      return 1
    }
    return 0
  }
  throw new Error('用法：plugin-refresh.mjs check|apply ...')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => {
    console.error(`插件检查失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
