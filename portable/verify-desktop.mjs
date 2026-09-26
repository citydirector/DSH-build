// verify-desktop.mjs —— 对组装好的绿色桌面包做静态验收（S1 验收清单的自动化部分）。
//
// 检查：
//   1. 入口与标记文件：DeepSeek Harness.exe / portable.flag / VERSION / update.json
//   2. 无更新来源：resources 下不得有 app-update.yml；asar 内 package.json 不得含 dshMandatoryUpdatePolicy
//   3. 迁移器：resources/dsh-build/migrate-sessions-v4.mjs 存在
//   4. 补丁在产物里：运行时段 tarball 内 dsh-workflow-ptc/lib/index.js 可解析、白名单含 instruction-hint
//   5. 数据面：产物不含 data/ 与个人数据
//
// 用法: node verify-desktop.mjs [--dir <staged package>]
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAR = 'C:\\Windows\\System32\\tar.exe'

/** 读 asar 头，取回内部文件的偏移与长度。 */
export function readAsarHeader(buffer) {
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'))
  // 文件数据区从 16 + 4 字节对齐后的头长度开始（实测：16+align4(hs) 处正好是第一个 entry 的内容）。
  return { header, dataOffset: 16 + ((headerSize + 3) & ~3) }
}

/** 从 asar 里读一个文件（目录树按 slash 分段）。 */
export function readAsarFile(buffer, path) {
  const { header, dataOffset } = readAsarHeader(buffer)
  let node = header
  for (const part of path.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) throw new Error(`asar: ${path} not found`)
  }
  if (typeof node.offset !== 'string' && typeof node.offset !== 'number') throw new Error(`asar: ${path} is a directory`)
  const start = dataOffset + Number(node.offset)
  return buffer.subarray(start, start + Number(node.size))
}

/** 在目录树里递归找匹配文件。 */
export function findFiles(root, predicate, depth = 0) {
  if (depth > 6 || !existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...findFiles(path, predicate, depth + 1))
    else if (predicate(path)) found.push(path)
  }
  return found
}

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
      // 补丁 1 的源码层形态：明文正则
      check(source.includes('replace(/\\s+/g, " ")'), 'runtime: native-code guard patched (source form)')
    } else if (name === 'dsh-workflow-ptc') {
      // 补丁 1 在 guest 源里的形态：位于字符串字面量内，转义成 \\s+ 与 \" \"
      check(source.includes('replace(/\\\\s+/g, \\" \\")'), 'runtime: guest source guard patched (escaped inside the literal)')
    } else {
      // 补丁 2：v2->v3 的 SOURCE_KINDS 白名单必须含历史 kind
      check(source.includes('instruction-hint'), 'runtime: v2->v3 SOURCE_KINDS whitelist carries instruction-hint')
      const kinds = /SOURCE_KINDS = new Set\(\[([\s\S]{0,400}?)\]\)/.exec(source)
      check(kinds !== null && kinds[1].includes('"user"') && kinds[1].includes('"instruction-hint"'), 'runtime: whitelist reads user + instruction-hint')
    }
  }
  // 便携引导：打包进 asar 的 main.js 必须带我们的 bootstrap
  try {
    const mainSource = readAsarFile(readFileSync(asarPath), 'lib/main.js').toString('utf8')
    check(mainSource.includes('portable.flag'), 'portable bootstrap compiled into lib/main.js')
    check(/session-v4-|MIGRATION_MARKER|migrate-sessions-v4\.mjs/.test(mainSource), 'session-migration hook compiled into lib/main.js')
  } catch (error) {
    problems.push(`FAIL lib/main.js — ${error instanceof Error ? error.message : String(error)}`)
  }

  check(!existsSync(join(stage, 'data')), 'ships no data/ (DSH_HOME is created on first run)')
  for (const leaked of ['desktop-seed', 'data/profiles/desktop/cordis.patch.yml', 'data/profiles/desktop/memory-kb.mjs', 'data/profiles/desktop/presets']) {
    check(!existsSync(join(stage, leaked)), `no personal data shipped: ${leaked}`)
  }

  const bytes = existsSync(stage) ? 0 : 0
  console.log(notes.join('\n'))
  console.log('')
  if (problems.length === 0) console.log('verify-desktop: 全部通过')
  else console.log('verify-desktop: 失败项\n' + problems.join('\n'))
  process.exit(problems.length === 0 ? 0 : 1)
}

if (import.meta.main) main()
