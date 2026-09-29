// check-peer-pins.mjs <workspace-root>
//
// 哨兵：把 workspace 各包里**精确版本**的 peerDependencies 钉法列出来。
//
// 为什么值得单独盯着：上游发布插件时，peer 用的是**精确版本**（如 `0.2.0-rc.2`），
// 不是 `^` / `~` / `workspace:`。而 dsh 的兼容门禁（dsh-app-boot 的 plugin-compatibility）
// 只校验 peerDependencies 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 那几条 —— 精确钉版
// 意味着：**profile 里 npm 装的插件，在 harness 每次升版时都会失效**；随包发布才自动跟随。
//
// 所以这条因果要一直看得见：
//   · 精确钉版还在 → 插件只能随包（我们的做法），不能指望 profile 安装；
//   · 哪天上游全改成 `^` / `~` → 这条约束松了，这里会打印"已无精确钉版"，可以回头重新评估；
//   · 上游**新引入**一批钉版 → 这里会多出几行，不必等插件在用户机器上炸才发现。
//
// 这是 note 级检查：**永远退出 0**（除非一个 @deepseek-ai 包都没扫到 —— 那说明扫描逻辑
// 或目录布局变了，退出 2 逼人来看，不静默放过）。钉版本身不是我们的 bug，不该拦构建。
//
// 用法：
//   node check-peer-pins.mjs <workspace-root>
//   node check-peer-pins.mjs --self-test
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** 和 patch-peers.mjs 一致：这些目录下才放 workspace 包。 */
const WORKSPACE_DIRS = ['vendor', 'packages', 'apps', 'native']

/**
 * 给一个 peerDependencies 的取值分类。
 * - workspace: 仓库内联（跟着源码走）
 * - range:     有范围符号（^ ~ > < = * x || 空格区间），跟着升版走
 * - exact:     裸版本号，钉死 —— 就是这条检查要抓的东西
 * - other:     认不出来（如 `latest`、git url、file:），也一并列出来
 */
export function classifyPeerSpec(spec) {
  if (typeof spec !== 'string') return 'other'
  const s = spec.trim()
  if (s === '') return 'other'
  if (s.startsWith('workspace:')) return 'workspace'
  if (s === '*' || s === 'latest') return 'range'
  if (/^[\^~><=]/.test(s)) return 'range'
  if (/\s/.test(s)) return 'range' // `||` 或 `1.0.0 - 2.0.0` 这类区间
  if (/^\d+\.\d+\.\d+/.test(s)) return 'exact'
  if (/\d\.[xX*]/.test(s)) return 'range'
  return 'other'
}

// 递归找每个 package.json，返回 [{ dir, manifest }]。读不了 / 不是 JSON 的静默跳过。
// （别在块注释里写带星号斜杠的路径 —— 那会提前把注释关掉，真踩过。）
function collectManifests(root) {
  const out = []
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        visit(full)
      } else if (e.name === 'package.json') {
        try {
          const manifest = JSON.parse(readFileSync(full, 'utf8'))
          if (manifest !== null && typeof manifest === 'object') out.push({ dir, manifest })
        } catch {
          /* 半成品 JSON 不是这条检查的事 */
        }
      }
    }
  }
  for (const d of WORKSPACE_DIRS) {
    const full = join(root, d)
    if (existsSync(full)) visit(full)
  }
  return out
}

/**
 * 扫一遍 workspace 的 peerDependencies。
 * @returns {{ packages: number, peerTotal: number, exact: {pkg:string,dir:string,name:string,spec:string,gate:boolean}[], other: {pkg:string,name:string,spec:string}[] }}
 *          `gate` = 这条会被 dsh 兼容门禁校验（@deepseek-ai/dsh 或 @deepseek-ai/dsh-*）。
 */
export function scanPeerPins(root) {
  const exact = []
  const other = []
  let packages = 0
  let peerTotal = 0
  for (const { dir, manifest } of collectManifests(root)) {
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) continue
    packages += 1
    const peers = manifest.peerDependencies
    if (peers === null || typeof peers !== 'object') continue
    for (const [name, spec] of Object.entries(peers)) {
      peerTotal += 1
      const kind = classifyPeerSpec(spec)
      const gate = name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
      if (kind === 'exact') exact.push({ pkg: manifest.name, dir, name, spec, gate })
      else if (kind === 'other') other.push({ pkg: manifest.name, name, spec })
    }
  }
  exact.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name))
  other.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name))
  return { packages, peerTotal, exact, other }
}

function report(root) {
  const { packages, peerTotal, exact, other } = scanPeerPins(root)
  if (packages === 0) {
    console.error(`peer-pins: 在 ${root} 下一个 @deepseek-ai 包都没扫到 —— 目录布局变了？`)
    return 2
  }
  console.log(`peer-pins: exact=${exact.length} of ${peerTotal} peer deps in ${packages} packages`)
  if (exact.length === 0) {
    console.log('peer-pins: 已无精确钉版 —— 上游若改用了 ^ / ~，profile 安装这条路重新可行，可回头评估。')
  } else {
    console.log('peer-pins: 以下 peer 是精确版本（钉死）→ 这些插件只能随包，profile 安装会在升版时失效：')
    for (const p of exact) {
      console.log(`  - ${p.pkg} → ${p.name}@${p.spec}${p.gate ? '   [兼容门禁会校验]' : ''}`)
    }
  }
  if (other.length > 0) {
    console.log('peer-pins: 认不出的取值（也一并看着）：')
    for (const p of other) console.log(`  - ${p.pkg} → ${p.name}: ${p.spec}`)
  }
  return 0
}

function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'peer-pins-'))
  const mk = (rel, text) => {
    mkdirSync(join(base, rel, '..'), { recursive: true })
    writeFileSync(join(base, rel), text)
  }
  mk('packages/a/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-a',
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2', '@deepseek-ai/cordis': '~4.0.4' },
  }))
  mk('packages/b/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-b',
    peerDependencies: { '@deepseek-ai/dsh-agent': 'workspace:*', '@deepseek-ai/dsh-scope': '^0.2.0' },
  }))
  mk('apps/c/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-c',
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0 <0.3.0', zod: '4.1.0', odd: 'file:../x' },
  }))
  mk('vendor/x/package.json', JSON.stringify({ name: 'not-ours', peerDependencies: { zod: '1.2.3' } }))
  const got = scanPeerPins(base)
  rmSync(base, { recursive: true, force: true })
  const fails = []
  if (got.packages !== 3) fails.push(`packages 期望 3，实际 ${got.packages}（非 @deepseek-ai 包应被忽略）`)
  if (got.peerTotal !== 7) fails.push(`peerTotal 期望 7，实际 ${got.peerTotal}`)
  const exactKeys = got.exact.map((p) => `${p.pkg}|${p.name}@${p.spec}|${p.gate}`).join(' , ')
  const want = '@deepseek-ai/dsh-a|@deepseek-ai/dsh-tools@0.2.0-rc.2|true , @deepseek-ai/dsh-c|zod@4.1.0|false'
  if (exactKeys !== want) fails.push(`exact 期望 [${want}]，实际 [${exactKeys}]`)
  const otherKeys = got.other.map((p) => `${p.name}:${p.spec}`).join(' , ')
  if (otherKeys !== 'odd:file:../x') fails.push(`other 期望 [odd:file:../x]，实际 [${otherKeys}]`)
  // 逐条分类也要对
  const cases = [
    ['workspace:*', 'workspace'],
    ['~4.0.4', 'range'],
    ['^0.2.0', 'range'],
    ['>=0.1.0 <0.3.0', 'range'],
    ['1.0.0 - 2.0.0', 'range'],
    ['*', 'range'],
    ['1.x', 'range'],
    ['0.2.0-rc.2', 'exact'],
    ['4.1.0', 'exact'],
    ['file:../x', 'other'],
    ['', 'other'],
  ]
  for (const [spec, wantKind] of cases) {
    const gotKind = classifyPeerSpec(spec)
    if (gotKind !== wantKind) fails.push(`classifyPeerSpec(${JSON.stringify(spec)}) 期望 ${wantKind}，实际 ${gotKind}`)
  }
  if (fails.length > 0) {
    for (const f of fails) console.error(`self-test: ✗ ${f}`)
    return 1
  }
  console.log('self-test: ✓ 扫描、门禁标记、分类都符合预期')
  return 0
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) process.exit(selfTest())
const rootArg = argv.find((a) => !a.startsWith('--'))
if (rootArg === undefined) {
  console.error('用法: node check-peer-pins.mjs <workspace-root> [--self-test]')
  process.exit(2)
}
process.exit(report(resolve(rootArg)))
