// patch-cua-ui-locate-bridge.mjs (--check | --digest) [--root <upstream-repo-root>]
//
// **只读工具，不改上游任何源码。** 2026-11-14 博士止损决定：撤销我们对上游 CUA 源码的全部注入
// （dispatch 分发面、系统输入队列、`deliveryMode` schema/能力位/guidance、Windows 后台投递），
// 只保留「新链默认启用 + helper 随包 + 完整性摘要」三件事。本脚本因此只做审计与摘要，不改上游一行源码：
//
//   --check   断言上游 CUA 源码仍是我们 pin 的原始形状（没有残留注入），逐文件报告 pristine / injected。
//             干净返回 0；发现残留文件或标识符返回 1 并逐个列出——**不修、不回滚、不猜**，交给构建失败。
//   --digest  输出一行 `kind=cua-helper-native-source` 的 JSON：`cua-windows/native` 整树摘要（跳过 bin/obj）。
//             这是 helper 的 build identity：上游 SHA 相同不代表 `dotnet publish` 出的二进制相同，
//             把摘要写进 `cua-helper.json` 才能在事后判断某个 helper 是用哪棵 native 树构建的。
//             摘要只允许取自**未被污染**的树，所以执行前先跑同一套 check。
//
// 为什么保留而不是删掉：helper 构建、portable、desktop 三处消费者都靠 `--digest` 记录并校验
// native 源码身份；删掉它就失去「这份二进制是不是这套源码构建的」这条证据链。
//
// 为什么不再需要锚点：注入代码本体已删除，没有 from/to 可匹配；本文件不再 import apply-edits。
// 兼容：仍接受位置参数（旧调用方），推荐新写法 `--check` / `--digest --root <dir>`。
import { createHash } from 'node:crypto'

import { existsSync, readFileSync, readdirSync } from 'node:fs'

import { join, relative, sep } from 'node:path'

const LABEL = 'patch-cua-ui-locate-bridge'

const CUA = 'packages/experimental/cua/src'
const WINDOWS = 'packages/experimental/cua-windows'
const NATIVE = 'packages/experimental/cua-windows/native'

/** 本地注入留下的整份文件：上游树里不该出现。 */
const FORBIDDEN_FILES = [
  `${CUA}/cua-dispatch.ts`,
  `${CUA}/cua-dispatch-guard.ts`,
  `${CUA}/system-input-queue.ts`,
]

/**
 * 本地注入留下的标识符。每条都经过实测：在干净的 39163dd 上游树上命中数为 0
 * （`_skadi_temp/upstream-pristine`），所以任何一次命中都意味着这棵树被改过。
 */
const FORBIDDEN_MARKERS = [
  {
    file: `${CUA}/index.ts`,
    markers: ['installCuaDispatch', 'systemInputQueue', 'deliveryModes'],
  },
  { file: `${CUA}/protocol.ts`, markers: ['deliveryMode'] },
  { file: `${CUA}/types.ts`, markers: ['deliveryModes'] },
  { file: `${CUA}/guidance.ts`, markers: ['deliveryMode'] },
  { file: `${WINDOWS}/src/index.ts`, markers: ['deliveryModes', 'BACKGROUND_UNAVAILABLE'] },
  { file: `${WINDOWS}/src/guidance.ts`, markers: ['deliveryMode'] },
  { file: `${NATIVE}/entry/Input.cs`, markers: ['ClickBackground', 'BACKGROUND_UNAVAILABLE'] },
  { file: `${NATIVE}/entry/Win32.cs`, markers: ['ChildWindowFromPointEx'] },
  { file: `${NATIVE}/entry/DesktopExecutor.cs`, markers: ['deliveryMode'] },
]

/**
 * 只读审计：上游树是否仍是 pin 的原始形状。
 *
 * 不抛错，把结论交回调用方——`--digest` 需要先判断能不能信这棵树，
 * 而 CLI 需要决定退出码（干净 0 / 残留 1）。
 *
 * @param {string} root - 上游仓根目录。
 * @returns {{ report: string[], problems: string[] }} problems 为空才算干净。
 */
export function checkUpstream(root) {
  const problems = []
  const report = []
  for (const file of FORBIDDEN_FILES) {
    if (existsSync(join(root, file))) {
      problems.push(`${file}: 文件存在（本地注入残留，本应随回滚删除）`)
      report.push(`${file}: injected`)
    }
  }
  for (const item of FORBIDDEN_MARKERS) {
    const path = join(root, item.file)
    if (!existsSync(path)) {
      problems.push(`${item.file}: 文件缺失（上游树不完整，可能是错的 checkout）`)
      report.push(`${item.file}: missing`)
      continue
    }
    const text = readFileSync(path, 'utf8')
    const hits = item.markers.filter((marker) => text.includes(marker))
    if (hits.length === 0) {
      report.push(`${item.file}: pristine`)
      continue
    }
    problems.push(`${item.file}: 含本地注入标识 ${hits.join(', ')}`)
    report.push(`${item.file}: injected (${hits.join(', ')})`)
  }
  return { report, problems }
}

/**
 * helper 源码身份：整棵 `cua-windows/native` 树的摘要（相对路径 + 内容，忽略 bin/obj）。
 *
 * 口径：按相对路径排序，逐文件 `path\0bytes\0` 喂 sha256，最后整体一次 digest。
 * 空目录不参与；只收普通文件（`withFileTypes` 下 isFile()），符号链接不会跟随，
 * 所以树外内容进不了摘要。
 *
 * @param {string} root - 上游仓根目录。
 * @returns {{ digest: string, files: Record<string, string> }} digest 形如 `sha256:…`，files 逐文件摘要。
 */
export function hashNativeTree(root) {
  const dir = join(root, NATIVE)
  if (!existsSync(dir)) throw new Error(`${LABEL}: missing native tree ${dir}`)
  const files = []
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'bin' || entry.name === 'obj') continue
        walk(full)
        continue
      }
      if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  const overall = createHash('sha256')
  const perFile = {}
  for (const full of files) {
    const key = relative(dir, full).split(sep).join('/')
    const bytes = readFileSync(full)
    perFile[key] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    overall.update(`${key}\u0000`).update(bytes).update('\u0000')
  }
  return { digest: `sha256:${overall.digest('hex')}`, files: perFile }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const digest = args.includes('--digest')
  // 位置参数与 `--root <dir>` 都接受：CI 里用 `--digest --root .`，读起来比 `. --digest` 清楚，
  // 也不会让「有没有裸调用」的 grep 把只读摘要误判成改源码。
  const rootFlag = args.indexOf('--root')
  const root = rootFlag >= 0
    ? args[rootFlag + 1]
    : args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--root')
  if (root === undefined || root.startsWith('--')) {
    throw new Error(`用法: node ${LABEL}.mjs <upstream-repo-root> [--check] [--digest]  或  --root <dir>`)
  }

  const { report, problems } = checkUpstream(root)
  for (const line of report) console.log(`${LABEL}: ${line}`)

  if (check) {
    if (problems.length > 0) {
      for (const problem of problems) console.error(`${LABEL}: 污染 — ${problem}`)
      console.error(`${LABEL}: 上游树不是 pin 的原始形状（${problems.length} 处残留）；--check 只读，不会替你修`)
      process.exit(1)
    }
    console.log(`${LABEL}: 干净 — 0 pending（上游 CUA 源码未被本地注入）`)
    process.exit(0)
  }

  if (digest) {
    // 摘要只在干净的树上才有意义：被改过的树算出来的值无法对应任何已知上游状态。
    if (problems.length > 0) {
      for (const problem of problems) console.error(`${LABEL}: 污染 — ${problem}`)
      throw new Error(`${LABEL}: 拒绝在被污染的树上生成 native 摘要（${problems.length} 处残留）`)
    }
    const native = hashNativeTree(root)
    console.log(JSON.stringify({
      kind: 'cua-helper-native-source',
      digest: native.digest,
      fileCount: Object.keys(native.files).length,
      files: native.files,
    }))
    console.log(`${LABEL}: native ${native.digest}（${Object.keys(native.files).length} 文件，只读摘要）`)
    process.exit(0)
  }

  // 裸调用：只报告，不写盘，也不改退出码（旧调用方若还在，至少能看到结论）。
  if (problems.length > 0) {
    console.error(`${LABEL}: ${problems.length} 处残留（用 --check 获取非零退出码）`)
  }
}
