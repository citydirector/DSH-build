// 从上游 engines.node 选出 CI 要装的 Node 主线，并在装好之后校验实际版本落在那一支里。
//
// 用法（工作目录 = 上游检出根）：
//   node _build_repo/ci/align-node.mjs            选主线，写 $GITHUB_OUTPUT 的 node_version / node_floor
//   node _build_repo/ci/align-node.mjs --assert   校验当前运行的 node（setup-node 之后、或用随包 node.exe 跑）
// 读的环境变量：NODE_VERSION（人工覆盖，留空 = 跟随上游）、GITHUB_OUTPUT。
//
// Why：上游 0.2.3-alpha.2 把 engines.node 收紧为 `^24.22.3 || >=26.13.1`（内置 undici 的 2026-11
// 安全修复首次出现在这两个版本）。workflow 原来写死 `node-version: "24"` 且不 check-latest，
// setup-node 会直接用 runner 工具缓存里现成的 24.x —— 2026-11-23 那次构建拿到的恰好是 24.22.3，
// 纯属侥幸；镜像缓存若还是 24.22.1，就会用一个上游明确拒绝的 Node 构建、并把它当 node.exe 随包发出去。
// 便携版随包的 node.exe 就是 CI 里这一份（ci/portable/stamp.ps1 拷 `Get-Command node`），
// 所以 CI 装哪个版本，用户手上就是哪个版本。
//
// 版本不手写：从 engines.node 的各个 `||` 分支里选**主版本最高**的那一支（现在是 >=26.13.1 → 26），
// workflow 再配 check-latest 拿该主线的最新补丁版。上游以后改成 >=28 时这里自动跟随，不必改 workflow。
// 为什么不直接用 setup-node 的 node-version-file 读 package.json：它把 engines 交给 semver 求
// 「满足范围的最高版本」，对 `>=26.13.1` 会解析到当时最新的任何主版本（包括奇数版 / 预发布线），
// 我们要的是一条确定的偶数主线，而且要能在装好后拿同一个判据复核。
//
// 只认上游实际用到的两种写法：`^X.Y.Z` 与 `>=X.Y.Z`。出现别的写法（`~`、`<`、`x` 通配、空格连写的
// 交集）一律报错退出 —— 宁可构建失败也不猜一个没验证过的版本（同 align-package-manager 的禁区原则）。
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 解析 x.y.z（接受前导 v 与预发布后缀），失败返回 undefined。 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(version).trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** 三段比较。 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

/**
 * 把 engines.node 拆成分支。
 * @param {string} range
 * @returns {{ branches: Array<{ op: '^' | '>=', floor: number[], text: string }> } | { error: string }}
 */
export function parseEngines(range) {
  const text = (range ?? '').trim()
  if (text === '') return { error: '上游 package.json 没有 engines.node；请设 NODE_VERSION 显式指定' }
  const branches = []
  for (const raw of text.split('||')) {
    const part = raw.trim()
    const match = /^(\^|>=)\s*(\d+\.\d+\.\d+)$/u.exec(part)
    if (match === null) return { error: `engines.node 里有不认识的写法 '${part}'（只支持 ^X.Y.Z 与 >=X.Y.Z）：${text}` }
    const floor = parseVersion(match[2])
    if (match[1] === '^' && floor[0] === 0) return { error: `engines.node 的 '${part}' 是 0.x 的 ^ 语义，不支持：${text}` }
    branches.push({ op: match[1], floor, text: part })
  }
  return { branches }
}

/** 某个版本是否满足某一支。 */
export function branchAccepts(branch, version) {
  if (compareVersions(version, branch.floor) < 0) return false
  return branch.op === '>=' || version[0] === branch.floor[0]
}

/**
 * 决定 CI 要装的 Node 主线与它的下限。
 * @param {{ engines?: string, override?: string }} input
 * @returns {{ major: number, floor: string, source: string, branch: string } | { error: string }}
 */
export function pickNode(input) {
  const parsed = parseEngines(input.engines)
  const override = (input.override ?? '').trim()
  if ('error' in parsed) {
    if (override === '') return parsed
    // 上游没声明 engines 时，覆盖值就是唯一依据：只校验格式。
    const exact = parseVersion(override)
    if (/^\d+$/u.test(override)) return { major: Number(override), floor: `${override}.0.0`, source: 'NODE_VERSION', branch: '(none)' }
    if (exact !== undefined) return { major: exact[0], floor: exact.join('.'), source: 'NODE_VERSION', branch: '(none)' }
    return { error: `无法解析 NODE_VERSION='${override}'（只接受主版本号如 26，或完整版本号如 26.13.1）` }
  }
  const { branches } = parsed
  if (override !== '') {
    // 覆盖值也必须落在上游声明的范围里 —— 紧急钉版不等于允许装一个上游拒绝的 Node。
    if (/^\d+$/u.test(override)) {
      const major = Number(override)
      const branch = branches.find((candidate) => candidate.op === '>=' ? major >= candidate.floor[0] : major === candidate.floor[0])
      if (branch === undefined) return { error: `NODE_VERSION=${override} 不在上游 engines.node（${input.engines}）允许的任何主线上` }
      const floor = major === branch.floor[0] ? branch.floor.join('.') : `${major}.0.0`
      return { major, floor, source: 'NODE_VERSION', branch: branch.text }
    }
    const exact = parseVersion(override)
    if (exact === undefined) return { error: `无法解析 NODE_VERSION='${override}'（只接受主版本号如 26，或完整版本号如 26.13.1）` }
    const branch = branches.find((candidate) => branchAccepts(candidate, exact))
    if (branch === undefined) return { error: `NODE_VERSION=${override} 不满足上游 engines.node（${input.engines}）` }
    return { major: exact[0], floor: exact.join('.'), source: 'NODE_VERSION', branch: branch.text }
  }
  let best = branches[0]
  for (const branch of branches) if (branch.floor[0] > best.floor[0]) best = branch
  return { major: best.floor[0], floor: best.floor.join('.'), source: 'engines.node', branch: best.text }
}

/**
 * 实际运行的 node 是否就是选定的那条主线、且不低于下限。
 * 主版本必须相等：选的是 26 却跑在 27 上，说明 setup-node 没按我们给的主线装，同样是错。
 * @returns {string | undefined} 错误信息；通过时返回 undefined。
 */
export function checkRuntime(picked, runningVersion) {
  const running = parseVersion(runningVersion)
  if (running === undefined) return `无法解析当前 node 版本 '${runningVersion}'`
  if (running[0] !== picked.major) return `当前 node ${runningVersion} 不在选定的主线 ${picked.major} 上（来自 ${picked.source}: ${picked.branch}）`
  if (compareVersions(running, parseVersion(picked.floor)) < 0) return `当前 node ${runningVersion} 低于下限 ${picked.floor}（来自 ${picked.source}: ${picked.branch}）`
  return undefined
}

/**
 * 命令行入口，独立成函数以便测试（测试不必起子进程）。
 * @returns {number} 退出码：0 成功；2 选不出版本 / 校验不通过。
 */
export function main({ argv = process.argv.slice(2), env = process.env, manifestPath = 'package.json', runningVersion = process.version, log = console.log, error = console.error } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const engines = typeof manifest.engines?.node === 'string' ? manifest.engines.node : ''
  const picked = pickNode({ engines, override: env.NODE_VERSION })
  if ('error' in picked) { error('align-node: ' + picked.error); return 2 }
  if (argv.includes('--assert')) {
    const problem = checkRuntime(picked, runningVersion)
    if (problem !== undefined) { error('align-node: ' + problem); return 2 }
    log(`node ${runningVersion} ok (line ${picked.major}, floor ${picked.floor}, from ${picked.source}: ${picked.branch})`)
    return 0
  }
  // 供 actions/setup-node 直接消费：主线只有一个来源，workflow 里不出现手写常量。
  const output = env.GITHUB_OUTPUT
  if (output !== undefined && output !== '') appendFileSync(output, `node_version=${picked.major}\nnode_floor=${picked.floor}\n`)
  log(`node ${picked.major} (floor ${picked.floor}, from ${picked.source}: ${picked.branch})`)
  return 0
}

// 这一步在 setup-node 之前、由 runner 自带的 node 跑，版本随镜像漂移：import.meta.main 是
// Node 24.2 才有的，老 node 上它是 undefined，脚本会静默什么都不做。所以退回比较 argv[1]。
const invokedDirectly = import.meta.main ?? (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url)
if (invokedDirectly) process.exitCode = main()
