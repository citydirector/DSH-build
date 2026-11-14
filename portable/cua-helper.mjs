// cua-helper.mjs —— Windows Computer Use helper 的产物契约：构建、暂存、校验、安装态解析。
//
// Why：上游 cua-windows 的安装态只做 `access(native/bin/win-<arch>/dsh-cua-windows.exe, X_OK)`，
// 从不编译（见 packages/experimental/cua-windows/src/native-build.ts 的 prepareNativeExecutable）。
// 也就是说 helper 必须由**构建期**准备好，随包发行；用户机器没有 .NET SDK，也不该被要求装。
// 上游 .github/workflows/cua-helper-package-windows.yml 定义了 payload 的形状（扁平根 +
// cua-helper.json，schemaVersion 1，files 全量 SHA256）。本文件实现同一份契约，并额外做
// 「校验通过才允许进产物」——缺文件、摘要不符、架构错、提交错都必须失败，绝不静默降级。
//
// 三种使用场景（CLI）：
//   node cua-helper.mjs publish --root <upstream> --out <dir> --commit <sha> --native-source-file <digest.json>
//       CI 的 Windows job 用：dotnet 10 locked restore → Protocol.Tests → win-x64 self-contained
//       publish → 写 cua-helper.json → 自校验。没有 SDK 时明确失败（本地不装 SDK）。
//       digest.json 是 patch-cua-ui-locate-bridge.mjs --digest 的输出。上游 native 树保持原样
//       （2026-11-14 已撤回全部本地注入），摘要只用来证明「这份二进制来自哪棵树」。
//   node cua-helper.mjs stage --from <payload-dir> --root <upstream> --commit <sha> [--native-digest sha256:…]
//       把已校验的 payload 放进 packages/experimental/cua-windows/native/bin/win-<arch>。
//   node cua-helper.mjs install --from <payload-dir> --package <安装态包目录> --commit <sha> [--native-digest …]
//       把 payload 放进任意包目录的 native/bin/win-<arch>（portable 的 app/node_modules 用）。
//   node cua-helper.mjs verify --root <upstream> --commit <sha> [--native-digest …]
//       校验上游树里的 payload（三产物接线后的构建前哨）。
//   node cua-helper.mjs verify-install --package <dsh-cua-windows 包目录> --commit <sha> [--native-digest …]
//       按上游 nativeExecutablePath 的语义（app.asar → app.asar.unpacked）解析**安装态**路径并校验。
//   node cua-helper.mjs verify-tarball --tarball <tgz> --commit <sha> [--native-digest …]
//       进程内 gunzip+tar 解到临时目录，校验 package/native/bin/win-x64 整树。
//
// 零依赖（Node ≥24）。所有路径先解析再判断；复制/删除只作用于解析后的预期路径。
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const MANIFEST_NAME = 'cua-helper.json'
export const SCHEMA_VERSION = 1
export const PLATFORM = 'windows'
export const DEFAULT_ARCHITECTURE = 'x64'
export const SUPPORTED_ARCHITECTURES = ['x64', 'arm64']
/** 上游 provider 在安装态读的目录名与可执行文件名。 */
export const PROVIDER_PACKAGE = 'packages/experimental/cua-windows'
export const HELPER_EXECUTABLE = 'dsh-cua-windows.exe'

/** 必须随 payload 一起出现的 self-contained 运行时文件（缺任何一个 = 用户机器上起不来）。 */
export const REQUIRED_RUNTIME_FILES = [
  'dsh-cua-windows.exe',
  'dsh-cua-windows.dll',
  'dsh-cua-windows.deps.json',
  'dsh-cua-windows.runtimeconfig.json',
]

/** 签名状态词表，与上游 `.github/workflows/cua-helper-package-windows.yml` 的注释一致。 */
export const SIGNING_KINDS = ['unsigned', 'authenticode']

/** 计算文件 SHA256（小写十六进制）。 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 计算一段文本的 SHA256（用于 buildKey）。 */
function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 递归列出目录下所有文件，返回相对路径（斜杠分隔、排序稳定）。
 * 不跟随符号链接：link 本身不是 helper 产物，出现即拒绝。
 */
export function walkFiles(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`cua-helper: ${path} 是符号链接，helper payload 只允许普通文件`)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile()) throw new Error(`cua-helper: ${path} 不是普通文件`)
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  walk(root)
  return files
}

/** 把一个相对路径限制在 root 之内（拒绝绝对路径与 .. 穿越）。 */
function safeJoin(root, rel) {
  if (isAbsolute(rel)) throw new Error(`cua-helper: 清单里的路径不能是绝对路径：${rel}`)
  const path = resolve(root, rel)
  const prefix = resolve(root) + sep
  if (path !== resolve(root) && !path.startsWith(prefix)) {
    throw new Error(`cua-helper: 清单里的路径越出了 payload 目录：${rel}`)
  }
  return path
}

/** 读取并做形状检查；不做摘要校验。 */
export function readManifest(directory) {
  const path = join(directory, MANIFEST_NAME)
  if (!existsSync(path)) throw new Error(`cua-helper: ${directory} 缺少 ${MANIFEST_NAME}`)
  let manifest
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    throw new Error(`cua-helper: ${MANIFEST_NAME} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const problems = []
  if (manifest?.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion 应为 ${SCHEMA_VERSION}，实际 ${String(manifest?.schemaVersion)}`)
  if (manifest?.platform !== PLATFORM) problems.push(`platform 应为 ${PLATFORM}，实际 ${String(manifest?.platform)}`)
  if (!SUPPORTED_ARCHITECTURES.includes(manifest?.architecture)) problems.push(`architecture 不支持：${String(manifest?.architecture)}`)
  if (manifest?.executable !== HELPER_EXECUTABLE) problems.push(`executable 应为 ${HELPER_EXECUTABLE}，实际 ${String(manifest?.executable)}`)
  if (typeof manifest?.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(manifest.commit)) problems.push(`commit 不是 40 位小写十六进制：${String(manifest?.commit)}`)
  if (typeof manifest?.version !== 'string' || manifest.version === '') problems.push('version 为空')
  if (typeof manifest?.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.sha256)) problems.push('sha256 不是 64 位小写十六进制')
  if (typeof manifest?.buildKey !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.buildKey)) problems.push('buildKey 不是 64 位小写十六进制')
  // 上游只比 commit 不够：同一个上游 commit 也可能被本地修过（曾经真的发生过），而「哪棵树编出来的」
  // 只有摘要能回答。摘要由 patch-cua-ui-locate-bridge.mjs --digest 产出，它同时审计树是否原样。
  if (manifest?.nativeSource === undefined) {
    problems.push('缺少 nativeSource（native 源码树摘要，来自 patch-cua-ui-locate-bridge.mjs --digest）')
  } else {
    try { validateNativeSource(manifest.nativeSource, `${MANIFEST_NAME}.nativeSource`) } catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
  }
  // 上游 helper workflow 的注释明确「signing is an enum: unsigned or authenticode」，
  // 这里跟着它的词表走：写 signed 之类自造值，消费端按上游枚举判断时会静默走错分支。
  if (!SIGNING_KINDS.includes(manifest?.signing)) problems.push(`signing 取值非法：${String(manifest?.signing)}（只接受 ${SIGNING_KINDS.join(' / ')}）`)
  if (manifest?.files === null || typeof manifest?.files !== 'object' || Array.isArray(manifest.files)) problems.push('files 必须是对象')
  if (problems.length > 0) throw new Error(`cua-helper: ${MANIFEST_NAME} 形状不合法：\n  - ` + problems.join('\n  - '))
  return manifest
}

/**
 * native 源码树的 build identity。由 `patch-cua-ui-locate-bridge.mjs --digest` 产出
 * 算出（native 整树按相对路径排序、逐文件 `path\0bytes\0` 喂 sha256），这里只校验形状并透传 ——
 * 两套口径会漂移，所以本文件不重算。它回答的是「这份 helper 是用哪棵 native 树编出来的」：
 * 上游 commit 相同、树被动过时，只有摘要能看出来。
 */
export function readNativeSource(file, commit) {
  let value
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    throw new Error(`cua-helper: 读不出原生源码摘要 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeNativeSource(value, commit)
}

/**
 * 接受两种形状：patch-cua-ui-locate-bridge.mjs --digest 的原始输出
 * （`{kind:'cua-helper-native-source', digest, fileCount, files}`），或已归一化的对象。
 * 归一时补上 algorithm 与 upstreamCommit —— 后者必须由调用方给出，不能靠猜。
 */
export function normalizeNativeSource(value, commit) {
  if (value !== null && typeof value === 'object' && value.kind === 'cua-helper-native-source') {
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
      throw new Error('cua-helper: 读取补丁摘要时需要 --commit（原始 --digest 输出不含提交号）')
    }
    return validateNativeSource({
      algorithm: 'sha256-tree-v1',
      digest: value.digest,
      upstreamCommit: commit,
      fileCount: value.fileCount,
      files: value.files,
    })
  }
  return validateNativeSource(value)
}

export function validateNativeSource(value, where = 'nativeSource') {
  const problems = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`cua-helper: ${where} 必须是对象（应来自 patch-cua-ui-locate-bridge.mjs --digest 的 JSON）`)
  }
  if (value.algorithm !== 'sha256-tree-v1') problems.push(`algorithm 应为 sha256-tree-v1，实际 ${String(value.algorithm)}`)
  if (typeof value.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.digest)) problems.push(`digest 不是 sha256:<64 hex>：${String(value.digest)}`)
  if (typeof value.upstreamCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.upstreamCommit)) problems.push(`upstreamCommit 不是 40 位小写十六进制：${String(value.upstreamCommit)}`)
  if (!Number.isInteger(value.fileCount) || value.fileCount <= 0) problems.push(`fileCount 不是正整数：${String(value.fileCount)}`)
  if (value.files === null || typeof value.files !== 'object' || Array.isArray(value.files)) problems.push('files 必须是对象')
  else {
    const entries = Object.entries(value.files)
    for (const [rel, digest] of entries) {
      if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) problems.push(`files.${rel} 不是 sha256:<64 hex>`)
    }
    if (entries.length !== value.fileCount) problems.push(`files 有 ${entries.length} 项，与 fileCount ${String(value.fileCount)} 不一致`)
  }
  if (problems.length > 0) throw new Error(`cua-helper: ${where} 的原生源码摘要不合法：\n  - ` + problems.join('\n  - '))
  return value
}

/**
 * 解一个 npm pack 生成的 .tgz。只用 node:zlib + 手工 tar 头，不 spawn 系统 tar：
 * 受限环境里 spawn 会 EPERM，CI 上也没必要多一层外部工具。只接受普通文件与目录，
 * 拒绝符号链接/绝对路径/`..` 穿越 —— tarball 是外部输入，不能让它写到目录外。
 */
export function extractTarGz(tarball, destination) {
  const buffer = gunzipSync(readFileSync(tarball))
  const root = resolve(destination)
  let offset = 0
  let files = 0
  const resolveEntry = (name) => {
    const parts = name.split('/').filter((part) => part !== '' && part !== '.')
    if (parts.includes('..') || isAbsolute(name) || /^[A-Za-z]:/u.test(name)) {
      throw new Error(`cua-helper: tarball 里有越界路径：${name}`)
    }
    return join(root, ...parts)
  }
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    if (rawName === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')
    const name = prefix === '' ? rawName : `${prefix}/${rawName}`
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) throw new Error(`cua-helper: tarball 里 ${name} 的大小字段无法解析`)
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156])
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) throw new Error(`cua-helper: tarball 被截断（${name}）`)
    if (type === '0' || type === '7') {
      const target = resolveEntry(name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer.subarray(dataStart, dataEnd))
      files++
    } else if (type === '5') {
      mkdirSync(resolveEntry(name), { recursive: true })
    } else if (type !== 'x' && type !== 'g') {
      // pax 扩展头（x/g）直接跳过；符号链接/硬链接一律拒绝。
      throw new Error(`cua-helper: tarball 里有不支持的条目类型 ${type}（${name}）`)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  if (files === 0) throw new Error(`cua-helper: ${tarball} 里没有任何文件`)
  return files
}

/**
 * 校验一个 payload 目录：清单形状、commit、每个文件的摘要、有没有多出未登记的文件、
 * 以及 self-contained 运行时必需文件。返回清单。
 * @param {string} directory
 * @param {{commit?: string, architecture?: string, nativeSourceDigest?: string}} [expect]
 */
export function verifyPayload(directory, expect = {}) {
  if (!existsSync(directory)) throw new Error(`cua-helper: payload 目录不存在：${directory}`)
  const manifest = readManifest(directory)
  if (expect.commit !== undefined && manifest.commit !== expect.commit) {
    throw new Error(`cua-helper: payload 来自上游 ${manifest.commit}，本次构建目标是 ${expect.commit}（不允许混入别的提交的 helper）`)
  }
  if (expect.architecture !== undefined && manifest.architecture !== expect.architecture) {
    throw new Error(`cua-helper: payload 架构是 ${manifest.architecture}，本次需要 ${expect.architecture}`)
  }
  // 读入别人产出的 artifact 时也要校验这条：writeManifest 只在「自己写清单」时查，
  // 而 CI 的消费端拿到的是下载来的 payload —— 少了这一步，一份「commit 与 nativeSource 互不对应」
  // 的清单能一路通过所有下游检查。
  if (manifest.nativeSource?.upstreamCommit !== manifest.commit) {
    throw new Error(`cua-helper: 清单自相矛盾 —— nativeSource.upstreamCommit 是 ${String(manifest.nativeSource?.upstreamCommit)}，`
      + `commit 却是 ${manifest.commit}（这份 helper 的元数据不是同一次构建写出来的）`)
  }
  if (expect.nativeSourceDigest !== undefined && manifest.nativeSource?.digest !== expect.nativeSourceDigest) {
    throw new Error(`cua-helper: helper 记录的 nativeSource.digest 是 ${String(manifest.nativeSource?.digest)}，期望 ${expect.nativeSourceDigest}`
      + '（helper 不是用这套 native 源码构建的 —— JS 侧与二进制会不匹配）')
  }
  const expected = manifest.files
  for (const rel of Object.keys(expected)) {
    const path = safeJoin(directory, rel)
    if (!existsSync(path)) throw new Error(`cua-helper: 清单登记了 ${rel}，但 payload 里没有`)
    const actual = sha256File(path)
    if (actual !== expected[rel]) throw new Error(`cua-helper: ${rel} 摘要不符（清单 ${expected[rel]}，实际 ${actual}）`)
  }
  const listed = new Set(Object.keys(expected))
  for (const rel of walkFiles(directory)) {
    if (rel === MANIFEST_NAME) continue
    if (!listed.has(rel)) throw new Error(`cua-helper: payload 里有未登记的文件：${rel}（清单必须覆盖整棵目录）`)
  }
  if (expected[HELPER_EXECUTABLE] === undefined) throw new Error(`cua-helper: 清单没有登记 ${HELPER_EXECUTABLE}`)
  if (manifest.sha256 !== expected[HELPER_EXECUTABLE]) throw new Error('cua-helper: 清单的 sha256 与 files 里 exe 的摘要不一致')
  for (const rel of REQUIRED_RUNTIME_FILES) {
    if (expected[rel] === undefined) throw new Error(`cua-helper: 缺少 self-contained 运行时文件 ${rel}（helper 在用户机器上会起不来）`)
  }
  return manifest
}

/**
 * 生成 cua-helper.json（files 不含清单自身）。只写元数据，不复制 payload。
 * @returns {object} 写下的清单。
 */
export function writeManifest(directory, { commit, version, sdk, architecture = DEFAULT_ARCHITECTURE, signing = 'unsigned', nativeSource }) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`cua-helper: commit 不是 40 位小写十六进制：${commit}`)
  if (typeof sdk !== 'string' || sdk.trim() === '') throw new Error('cua-helper: 缺少 .NET SDK 版本，无法生成 buildKey')
  if (typeof version !== 'string' || version === '') throw new Error('cua-helper: 缺少上游版本号')
  validateNativeSource(nativeSource, 'writeManifest')
  if (nativeSource.upstreamCommit !== commit) {
    throw new Error(`cua-helper: 原生源码摘要记录的 upstreamCommit 是 ${nativeSource.upstreamCommit}，与本次 ${commit} 不一致`)
  }
  const files = {}
  for (const rel of walkFiles(directory)) {
    if (rel === MANIFEST_NAME) continue
    files[rel] = sha256File(safeJoin(directory, rel))
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    platform: PLATFORM,
    buildKey: sha256Text(`${commit}\n${sdk}\n${architecture}`),
    version,
    commit,
    architecture,
    executable: HELPER_EXECUTABLE,
    sha256: files[HELPER_EXECUTABLE],
    signing,
    nativeSource,
    files,
  }
  writeFileSync(join(directory, MANIFEST_NAME), JSON.stringify(manifest, undefined, 2) + '\n')
  return manifest
}

/** 安装态目录名：`win-x64` / `win-arm64`（与上游 nativeExecutablePath 一致）。 */
export function helperDirectoryName(architecture) {
  if (!SUPPORTED_ARCHITECTURES.includes(architecture)) throw new Error(`cua-helper: 不支持的架构：${architecture}`)
  return `win-${architecture}`
}

/** 上游树里 helper 应放的位置。 */
export function sourceHelperDirectory(root, architecture = DEFAULT_ARCHITECTURE) {
  return join(resolve(root), PROVIDER_PACKAGE, 'native', 'bin', helperDirectoryName(architecture))
}

/** 读取上游根 package.json 的版本号。 */
export function upstreamVersion(root) {
  const path = join(resolve(root), 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version === '') throw new Error(`cua-helper: ${path} 没有 version`)
  return manifest.version
}

/**
 * 按上游 nativeExecutablePath 的语义解析安装态 helper 路径：
 *   app.asar → app.asar.unpacked，再拼 native/bin/win-<arch>/dsh-cua-windows.exe。
 * 只做路径解析，不判断存在。
 */
export function installedExecutablePath(packageRoot, architecture = DEFAULT_ARCHITECTURE) {
  const root = resolve(packageRoot).replace(/([\\/])app\.asar(?=[\\/])/u, '$1app.asar.unpacked')
  return join(root, 'native', 'bin', helperDirectoryName(architecture), HELPER_EXECUTABLE)
}

/** 安装态 packageRoot 下的 payload 目录。 */
export function installedHelperDirectory(packageRoot, architecture = DEFAULT_ARCHITECTURE) {
  return dirname(installedExecutablePath(packageRoot, architecture))
}

/** 校验安装态：路径按上游语义解析、payload 完整、commit 一致。返回清单。 */
export function verifyInstalled(packageRoot, expect = {}) {
  const directory = installedHelperDirectory(packageRoot, expect.architecture ?? DEFAULT_ARCHITECTURE)
  const executable = join(directory, HELPER_EXECUTABLE)
  if (!existsSync(executable)) {
    throw new Error(`cua-helper: 安装态缺 ${executable}（上游 prepareNativeExecutable 会以 ENOENT 拒绝激活）`)
  }
  return verifyPayload(directory, expect)
}

/** 把 payload 复制到任意安装态包目录的 native/bin/win-<arch>（portable 的 app/node_modules 用）。
 *  先校验来源，再替换目标；目标目录只允许落在 packageRoot 之内。 */
export function installPayload(from, packageRoot, expect = {}) {
  const source = resolve(from)
  const manifest = verifyPayload(source, expect)
  const root = resolve(packageRoot)
  const target = join(root, 'native', 'bin', helperDirectoryName(manifest.architecture))
  if (!target.startsWith(root + sep)) throw new Error(`cua-helper: 目标路径越界：${target}`)
  // 目标在来源里面时，先 rmSync(target) 会把来源一起删掉（复制到一半源没了）。宁可直接拒绝。
  if (source === target || source.startsWith(target + sep)) {
    throw new Error(`cua-helper: 来源位于目标目录之内（${source} ⊂ ${target}），替换目标会先删掉来源`)
  }
  if (existsSync(target)) {
    try {
      const current = verifyPayload(target, expect)
      if (JSON.stringify(current.files) === JSON.stringify(manifest.files)) return { directory: target, manifest, changed: false }
    } catch {
      // 目标不完整/被篡改：覆盖
    }
    rmSync(target, { recursive: true, force: true })
  }
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, dereference: false })
  const installed = verifyPayload(target, expect)
  return { directory: target, manifest: installed, changed: true }
}

/** 把 payload 复制到上游树的 native/bin/win-<arch>；先校验来源，再替换目标。 */
export function stagePayload(from, root, expect = {}) {
  const source = resolve(from)
  const manifest = verifyPayload(source, expect)
  const target = sourceHelperDirectory(root, manifest.architecture)
  const expectedRoot = resolve(root, PROVIDER_PACKAGE, 'native', 'bin')
  if (!resolve(target).startsWith(expectedRoot + sep)) throw new Error(`cua-helper: 目标路径越界：${target}`)
  return installPayload(source, join(resolve(root), PROVIDER_PACKAGE), expect)
}

/** 解析 dotnet 主版本；没有 SDK 时给出明确指引。 */
function dotnetVersion() {
  const result = spawnSync('dotnet', ['--version'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('cua-helper: 找不到 dotnet。helper 只能在装有 .NET 10 SDK 的 Windows CI 上构建；'
      + '本机/产物构建不应安装 SDK，也不应联网编译（上游安装态只查文件）。'
      + `（${result.error?.message ?? String(result.stderr).trim()}）`)
  }
  return result.stdout.trim()
}

function run(what, command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`cua-helper: ${what} 失败（退出码 ${String(result.status ?? result.signal)}）`)
}

/**
 * 构建 payload：locked restore → Protocol.Tests → win-<arch> self-contained publish → 元数据。
 * 只有 CI 的 Windows job 调它；失败必须响亮（不吞 dotnet 输出）。
 */
/**
 * 解析并校验 publish 的输出目录：publish 会先 rmSync(output)，一个手滑的 --out 能删掉
 * 整棵上游或原生源码。逐条拒绝，不靠调用方自觉。导出成独立函数是为了能在没有 dotnet
 * 的机器上单测（publishHelper 本身第一句就要 SDK）。
 */
export function resolveSafeOutput(out, root) {
  const upstream = resolve(root)
  const nativeRoot = join(upstream, PROVIDER_PACKAGE, 'native')
  const output = resolve(out)
  if (output === parsePath(output).root) throw new Error(`cua-helper: --out 不能是文件系统根：${output}`)
  if (output === upstream) throw new Error(`cua-helper: --out 不能是上游根目录本身（会被清空）：${output}`)
  if (upstream.startsWith(output + sep)) throw new Error(`cua-helper: --out 是上游的祖先目录（会被清空）：${output}`)
  if (output === nativeRoot || output.startsWith(nativeRoot + sep)) throw new Error(`cua-helper: --out 不能落在原生源码树里（源码会被删）：${output}`)
  if (nativeRoot.startsWith(output + sep)) throw new Error(`cua-helper: --out 包含原生源码树（源码会被删）：${output}`)
  return { output, upstream, nativeRoot }
}

export function publishHelper({ root, out, commit, architecture = DEFAULT_ARCHITECTURE, nativeSource }) {
  const { output, upstream, nativeRoot } = resolveSafeOutput(out, root)
  const sdk = dotnetVersion()
  const major = Number.parseInt(sdk.split('.')[0], 10)
  if (!Number.isInteger(major) || major < 10) throw new Error(`cua-helper: 需要 .NET 10 SDK，实际 ${sdk}`)
  // 先校验摘要再花十分钟编译：摘要与本次提交/源码树对不上，就不该产出二进制。
  validateNativeSource(nativeSource, 'publishHelper')
  if (nativeSource.upstreamCommit !== commit) {
    throw new Error(`cua-helper: 原生源码摘要来自 ${nativeSource.upstreamCommit}，本次 publish 目标是 ${commit}`)
  }
  const solution = join(nativeRoot, 'cua-windows.slnx')
  if (!existsSync(solution)) throw new Error(`cua-helper: 找不到 ${solution}，上游改了原生工程布局？`)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  run('dotnet restore --locked-mode', 'dotnet', ['restore', solution, '--locked-mode'], { cwd: upstream })
  run('Protocol.Tests', 'dotnet', ['run', '--project', join(nativeRoot, 'tests', 'Protocol.Tests.csproj'),
    '--configuration', 'Release', '--no-restore'], { cwd: upstream })
  run('dotnet publish', 'dotnet', ['publish', join(nativeRoot, 'entry', 'CuaWindows.csproj'),
    '--configuration', 'Release', '--runtime', `win-${architecture}`, '--self-contained', 'true',
    '--no-restore', '--output', output], { cwd: upstream })
  if (!existsSync(join(output, HELPER_EXECUTABLE))) throw new Error(`cua-helper: publish 结束但 ${HELPER_EXECUTABLE} 不存在：${output}`)
  writeManifest(output, { commit, version: upstreamVersion(upstream), sdk, architecture, nativeSource })
  return verifyPayload(output, { commit, architecture, nativeSourceDigest: nativeSource.digest })
}

/** 解析命令行：模式 + 具名参数。认不出的参数直接失败（猜错路径会改错文件）。 */
export function parseArgs(argv) {
  const [mode, ...rest] = argv
  const options = { mode }
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`cua-helper: 认不出的参数 ${token}`)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`cua-helper: ${token} 缺少取值`)
    index++
    options[token.slice(2)] = value
  }
  return options
}

function requireOption(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value === '') throw new Error(`cua-helper: 缺少 --${name}`)
  return value
}
/**
 * 消费端用 `--native-source-file`（摘要工具的整行 JSON）或 `--native-digest`（只要摘要值）传期望值。
 * 两者都给时必须一致；只给 `--native-digest` 也必须真的比较 —— 否则「传了却没校验」会静静地放过旧二进制。
 */
function digestExpectation(options) {
  const file = options['native-source-file']
  const bare = options['native-digest']
  if (bare !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(String(bare))) {
    throw new Error(`cua-helper: --native-digest 必须是 sha256:<64 位小写十六进制>，收到 ${String(bare)}`)
  }
  if (file === undefined) return bare === undefined ? {} : { nativeSourceDigest: String(bare) }
  const nativeSource = readNativeSource(file, options.commit)
  if (bare !== undefined && String(bare) !== nativeSource.digest) {
    throw new Error(`cua-helper: --native-digest ${String(bare)} 与 ${file} 的 ${nativeSource.digest} 不一致`)
  }
  return { nativeSourceDigest: nativeSource.digest }
}

/** CLI 主入口。 */
export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const architecture = options.architecture ?? DEFAULT_ARCHITECTURE
  switch (options.mode) {
    case 'publish': {
      const commit = requireOption(options, 'commit')
      const nativeSource = readNativeSource(requireOption(options, 'native-source-file'), commit)
      const manifest = publishHelper({ root: requireOption(options, 'root'), out: requireOption(options, 'out'), commit, architecture, nativeSource })
      console.log(`cua-helper: published ${manifest.architecture} helper (${Object.keys(manifest.files).length} files, buildKey ${manifest.buildKey}, native ${manifest.nativeSource.digest.slice(0, 19)}…)`)
      return 0
    }
    case 'stage': {
      const result = stagePayload(requireOption(options, 'from'), requireOption(options, 'root'), { commit: options.commit, architecture, ...digestExpectation(options) })
      console.log(`cua-helper: staged ${result.manifest.architecture} helper → ${result.directory}${result.changed ? '' : '（已是最新，未写盘）'}`)
      return 0
    }
    case 'install': {
      const result = installPayload(requireOption(options, 'from'), requireOption(options, 'package'), { commit: options.commit, architecture, ...digestExpectation(options) })
      console.log(`cua-helper: installed ${result.manifest.architecture} helper → ${result.directory}${result.changed ? '' : '（已是最新，未写盘）'}`)
      return 0
    }
    case 'verify': {
      const manifest = verifyPayload(sourceHelperDirectory(requireOption(options, 'root'), architecture), { commit: options.commit, architecture, ...digestExpectation(options) })
      console.log(`cua-helper: verified ${manifest.architecture} helper (${Object.keys(manifest.files).length} files)`)
      return 0
    }
    case 'verify-install': {
      const manifest = verifyInstalled(requireOption(options, 'package'), { commit: options.commit, architecture, ...digestExpectation(options) })
      console.log(`cua-helper: verified installed ${manifest.architecture} helper at ${installedExecutablePath(requireOption(options, 'package'), architecture)}`)
      return 0
    }
    case 'verify-tarball': {
      const tarball = resolve(requireOption(options, 'tarball'))
      if (!existsSync(tarball)) throw new Error(`cua-helper: 找不到 tarball：${tarball}`)
      const temporary = join(dirname(tarball), '_cua-helper-extract')
      rmSync(temporary, { recursive: true, force: true })
      mkdirSync(temporary, { recursive: true })
      try {
        const files = extractTarGz(tarball, temporary)
        const manifest = verifyInstalled(join(temporary, 'package'), { commit: options.commit, architecture, ...digestExpectation(options) })
        console.log(`cua-helper: verified tarball helper (${Object.keys(manifest.files).length}/${files} extracted files)`)
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
      return 0
    }
    default:
      throw new Error('用法: node cua-helper.mjs <publish|stage|install|verify|verify-install|verify-tarball> [选项]')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
