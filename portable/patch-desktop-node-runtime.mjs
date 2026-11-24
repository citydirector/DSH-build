// patch-desktop-node-runtime.mjs <upstream-repo-root> [--node <X.Y.Z>]
//
// 把桌面版 primary-runtime 自带的独立 Node 换成构建用的那份 Node（CI 里 = ci/align-node.mjs 从上游
// engines.node 选出的最高主线、setup-node check-latest 装的最新补丁版，现为 26）。
//
// 这份 Node 不跑宿主：宿主与插件跑在 Electron 自带的 Node 里（Electron 44 / 45 都是 24.22.3，跟着上游
// 的 Electron 走，这里不碰）。它服务的是：
//   - load_workspace_dependencies 交给 agent 的独立 Node（复制到 $DSH_HOME/dsh-runtimes）；
//   - dsh-portable-bootstrap.ts 设的 BILLION_CONTEXT_NODE（插件自己起的 Node 子进程）。
// 换的理由：24 自 2026-10-20 进入维护期，26 是 Active LTS；两条线同日安全版本修的 CVE 一致，但 26 的
// V8 14.6 在 JSON / await / gzip 上实测快 1.8～2 倍。
//
// 只改 scripts/primary-runtime/lock.json 里两类值，保持键顺序与格式（上游说键顺序影响产物身份）：
//   "nodeVersion": "<旧>"     → "<新>"                                   恰好 1 次
//   每个 target 的 "nodeSha256" → 新版本官方 SHASUMS256.txt 里对应压缩包的哈希   各恰好 1 次
// prepare.ts 按 nodeVersion 拼下载地址、按 nodeSha256 校验、装好后再核对 process.versions.node，
// 所以改这两处就够，不动 prepare.ts。
//
// 规则：
//   - 新版本 = --node 参数，缺省为跑本脚本的 Node（process.versions.node）；
//   - 只升不降：新版本低于锁里的版本直接报错（本机用旧 Node 跑构建会在这里被拦下）；
//   - 哈希取自 https://nodejs.org/dist/v<新>/SHASUMS256.txt（与 actions/setup-node 同一信任源），
//     每个 target 的压缩包名必须恰好出现 1 次，否则报错；
//   - 锁里已是新版本：什么都不写，也不联网（幂等）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEditsToFiles } from './lib/apply-edits.mjs'

export const LOCK = 'scripts/primary-runtime/lock.json'
const LABEL = 'patch-desktop-node-runtime'

/** 解析 X.Y.Z（可带前缀 v），其它写法一律报错。 */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(value).trim())
  if (match === null) throw new Error(`${LABEL}: 不认识的 Node 版本 ${JSON.stringify(value)}（只接受 X.Y.Z）`)
  return match.slice(1).map(Number)
}

/** 比较两个 X.Y.Z：a 大于 b 返回正数，相等返回 0。 */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * 从 SHASUMS256.txt 取各压缩包的哈希。
 * @param {string} text - SHASUMS256.txt 全文。
 * @param {string} version - Node 版本 X.Y.Z。
 * @param {string[]} archives - lock 里各 target 的 nodeArchive（如 win-x64.zip）。
 * @returns {Record<string, string>} nodeArchive → sha256。
 */
export function hashesFromShasums(text, version, archives) {
  const rows = String(text).split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).filter((parts) => parts.length === 2)
  const out = {}
  for (const archive of archives) {
    const file = `node-v${version}-${archive}`
    const hits = rows.filter((parts) => parts[1] === file)
    if (hits.length !== 1) throw new Error(`${LABEL}: SHASUMS256.txt 里 ${file} 应恰好 1 行，实际 ${hits.length} 行`)
    const hash = hits[0][0].toLowerCase()
    if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`${LABEL}: ${file} 的哈希不是 64 位十六进制：${hits[0][0]}`)
    out[archive] = hash
  }
  return out
}

/**
 * 读锁、判断升降级。
 * @param {string} lockText - lock.json 原文。
 * @param {string} version - 目标版本。
 * @returns {{ lock: any, current: string, order: number }} order > 0 才需要改。
 */
export function inspectLock(lockText, version) {
  const lock = JSON.parse(lockText)
  const current = lock?.nodeVersion
  if (typeof current !== 'string') throw new Error(`${LABEL}: ${LOCK} 没有字符串 nodeVersion`)
  const order = compareVersions(version, current)
  if (order < 0) {
    throw new Error(`${LABEL}: 构建用的 Node ${version} 低于上游锁定的 ${current}，拒绝降级；`
      + '先装上游 engines.node 选定的主线（见 ci/align-node.mjs）再构建')
  }
  return { lock, current, order }
}

/**
 * 生成编辑列表；已是目标版本时返回空数组。
 * @param {string} lockText - lock.json 原文。
 * @param {string} version - 目标版本。
 * @param {string} shasumsText - 目标版本的 SHASUMS256.txt。
 */
export function planEdits(lockText, version, shasumsText) {
  const { lock, current, order } = inspectLock(lockText, version)
  if (order === 0) return []
  const targets = Object.entries(lock.targets ?? {})
  if (targets.length === 0) throw new Error(`${LABEL}: ${LOCK} 没有 targets`)
  for (const [name, target] of targets) {
    if (typeof target?.nodeArchive !== 'string' || typeof target?.nodeSha256 !== 'string') {
      throw new Error(`${LABEL}: target ${name} 缺 nodeArchive 或 nodeSha256`)
    }
  }
  const hashes = hashesFromShasums(shasumsText, version, targets.map(([, target]) => target.nodeArchive))
  const plain = parseVersion(version).join('.')
  return [
    { name: `nodeVersion ${current} -> ${plain}`, file: LOCK, from: `"nodeVersion": "${current}"`, to: `"nodeVersion": "${plain}"` },
    ...targets.map(([name, target]) => ({
      name: `${name} nodeSha256`,
      file: LOCK,
      from: `"nodeSha256": "${target.nodeSha256}"`,
      to: `"nodeSha256": "${hashes[target.nodeArchive]}"`,
    })),
  ]
}

/**
 * 应用补丁（幂等）。
 * @param {string} root - upstream 仓库根目录。
 * @param {string} version - 目标 Node 版本。
 * @param {string} shasumsText - 目标版本的 SHASUMS256.txt。
 * @returns {{ applied: string[] }}
 */
export function patchDesktopNodeRuntime(root, version, shasumsText) {
  const edits = planEdits(readFileSync(join(root, LOCK), 'utf8'), version, shasumsText)
  return edits.length === 0 ? { applied: [] } : applyEditsToFiles(root, edits, LABEL)
}

/** 下载目标版本的 SHASUMS256.txt；非 2xx 直接报错。 */
export async function fetchShasums(version, fetchImpl = fetch) {
  const url = `https://nodejs.org/dist/v${parseVersion(version).join('.')}/SHASUMS256.txt`
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${LABEL}: 下载 ${url} 失败：HTTP ${response.status}`)
  return response.text()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = args[0]
  const at = args.indexOf('--node')
  const version = at >= 0 ? args[at + 1] : process.versions.node
  if (root === undefined || root.startsWith('--') || version === undefined) {
    console.error('用法: node patch-desktop-node-runtime.mjs <repo-root> [--node <X.Y.Z>]')
    process.exit(2)
  }
  try {
    const { current, order } = inspectLock(readFileSync(join(root, LOCK), 'utf8'), version)
    if (order === 0) {
      console.log(`${LABEL}: already ${current}`)
    } else {
      const { applied } = patchDesktopNodeRuntime(root, version, await fetchShasums(version))
      console.log(`${LABEL}: applied ${applied.length} edit(s)\n  - ${applied.join('\n  - ')}`)
    }
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}
