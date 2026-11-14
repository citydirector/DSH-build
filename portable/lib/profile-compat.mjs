// portable/lib/profile-compat.mjs —— 升级期把用户 profile 的 cordis.patch.yml 迁移到新运行时。
//
// 为什么需要：portable/ 里的补丁全在构建期干活，改的是上游源码树；而 cordis.patch.yml 住在
// data/profiles/<profile>/ 里，运行时才读（profile package.json 的 patchReload: live），
// 构建期根本不存在于源码树。上游一旦删掉一个子路径导出、改掉一个 config 键名，用户那份手写
// 配置就会 import 失败 → 预设整组挂不上 → 建会话失败。这一层补的就是它。
//
// 三条原则：
//   1. 只按「新运行时自己的实际能力」判断（resolve 得到 / 包源码里确实有这个字段），
//      不维护任何版本对照表 —— 上游下一版再改，这里不用动。
//   2. 文本锚点，不 parse 也不 dump。这份文件里有用户手写的注释，YAML round-trip 会把它们全冲掉。
//   3. 幂等 + 保守：已经是目标状态就一个字节都不写；判据说不清（包解析不到、源码读不出）
//      就原样保留并回报，绝不猜着改。改坏了用户起不来，比不改更糟。
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** 一份 profile 配置里，我们认识并负责迁移的包。 */
const SUBAGENT = '@deepseek-ai/dsh-tool-subagent'
const PI_AI = '@deepseek-ai/dsh-llm-pi-ai'
const PRESENTATION = '@deepseek-ai/dsh-agent-tool-presentation'
const EXECUTOR_PTC = '@deepseek-ai/dsh-tool-executor-ptc'
const LIST_AGENTS = '@deepseek-ai/dsh-tool-subagent-control/list-agents'

/** DSH-build 历史上当运行时依赖发过、因而可能出现在用户 profile 插件行里的旧 Computer Use provider。 */
const LEGACY_COMPUTER_USE_PROVIDERS = new Set([
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
])
const LEGACY_NATIVE_NAME = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
const LEGACY_MCP_NAME = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
/**
 * 允许**自动迁移**的旧行 (id, name)，以及迁移后必须保持的发行形状。
 *
 * native 的证据是**真实发行的 desktop profile**：`data/profiles/desktop/cordis.patch.yml` 里
 * `- insert:` 段下（缩进 4）写着
 *   `- id: computer-use-cua-native` + `name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'`。
 * 注意 id **不是**包名尾段：发行用的是 `computer-use-cua-native`，照包名猜会永远匹配不上真实配置。
 * 这份证据不在本仓 git 历史里是对的 —— 本仓只发构建脚本，profile 的插件行由安装器/用户生成，
 * `git log -S` 查不到不等于没发过。
 *
 * mcp 的证据是上游 39163dd 的 `snapshots/session/computer-use-cua-driver-mcp/cordis.yml:32-33`。
 */
const AUTO_MIGRATABLE_LEGACY_ROWS = new Map([
  [LEGACY_NATIVE_NAME, 'computer-use-cua-native'],
  [LEGACY_MCP_NAME, 'computer-use-cua-driver-mcp'],
])
/**
 * 旧注册表行。新 bundle 的 cordis.patch.yml 自带 `cua-provider-registry`（同一个
 * `@deepseek-ai/dsh-computer-use`），所以同一父节点里那行必须跟着旧 provider 一起消失 ——
 * 否则一个 profile 里会出现两份注册表实例。
 */
const LEGACY_REGISTRY_NAME = '@deepseek-ai/dsh-computer-use'
const LEGACY_REGISTRY_IDS = new Set(['computer-use'])
/** 新链入口在 profile 里用的 id；迁移前必须确认它没被别的插件占着。 */
const CUA_BUNDLE_ID = 'cua-bundle'
/** 新链的入口包：bundle 自带 registry 与平台 provider。 */
const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'
const CUA_PROVIDER_PACKAGES = new Set([CUA_BUNDLE, '@deepseek-ai/dsh-cua-windows', '@deepseek-ai/dsh-cua-macos'])

/** 去掉行尾 CR，返回 [纯文本, 是否原本有 CR]。 */
function splitLines(text) {
  const crlf = text.includes('\r\n')
  return { lines: text.split(/\r?\n/u), crlf }
}

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 从一行里解出 `- id: <name>` 的 id；不是 id 行返回 undefined。 */
function rowId(line) {
  const match = /^([ \t]*)-[ \t]+id:[ \t]*(.+?)[ \t]*$/u.exec(line)
  if (match === null) return undefined
  return { indent: match[1], id: unquote(match[2]) }
}

/** 从一行里解出 `name: <spec>` 的 spec；不是 name 行返回 undefined。 */
function rowName(line) {
  const match = /^([ \t]*)name:[ \t]*(.+?)[ \t]*$/u.exec(line)
  if (match === null) return undefined
  return { indent: match[1], name: unquote(match[2]) }
}

/** 从一行里解出 `key: value`。 */
function rowKey(line, key) {
  const pattern = new RegExp('^([ \\t]*(?:-[ ][ \\t]*)?)' + key + ':[ \\t]*(.*?)[ \\t]*$', 'u')
  const match = pattern.exec(line)
  if (match === null) return undefined
  return { indent: match[1], value: match[2] }
}

/** 一行的缩进宽度（制表符按两格算；真实 profile 全是空格）。 */
function indentWidth(line) {
  return /^[ \t]*/u.exec(line)[0].replace(/\t/gu, '  ').length
}

/** 是否是 YAML 列表项起点（`- foo`，或只有 `-` 的续行）。 */
function isListItem(line) {
  return /^[ \t]*-[ \t]*\S/u.test(line) || /^[ \t]*-[ \t]*$/u.test(line)
}

/**
 * 一行所属的父级：向上找第一条缩进更浅的非空行；它必须是列表项（`- insert:` 之类）才算父。
 * 返回行号，找不到返回 -1。同父判定靠它 —— 真实发行 profile 的插件行全在 `- insert:` 下面。
 */
function parentIndexOf(lines, index) {
  const width = indentWidth(lines[index])
  for (let at = index - 1; at >= 0; at--) {
    if (lines[at].trim() === '') continue
    if (indentWidth(lines[at]) < width) return isListItem(lines[at]) ? at : -1
  }
  return -1
}

/**
 * 所有 `- id:` 插件块 —— **不限缩进**。
 *
 * 曾经的实现只认顶层（`indent === ''`），而真实发行 profile 把插件行写在 `- insert:` 下面（缩进 4），
 * 于是升级时整段被漏掉：一个字节不改、连告警都没有，用户看到的是「新默认不生效、旧 provider 还在占槽」。
 * 现在按缩进深度与兄弟关系划块：遇到同层（或更浅）的列表项、或更浅的非列表行就结束。
 * `end` 是内容末尾（尾随空行不算块内容，写回时原样保留，免得吃掉段间分隔）；
 * `stop` 是下一个兄弟/父级的起点。
 */
function pluginBlocks(lines) {
  const blocks = []
  for (let index = 0; index < lines.length; index++) {
    const row = rowId(lines[index])
    if (row === undefined) continue
    const width = indentWidth(lines[index])
    let stop = index + 1
    while (stop < lines.length) {
      const line = lines[stop]
      if (line.trim() === '') {
        stop++
        continue
      }
      const nextWidth = indentWidth(line)
      if (nextWidth < width) break
      if (nextWidth === width && isListItem(line)) break
      stop++
    }
    let end = stop
    while (end > index + 1 && lines[end - 1].trim() === '') end--
    let name
    for (let at = index + 1; at < end; at++) {
      const found = rowName(lines[at])
      if (found !== undefined && indentWidth(lines[at]) > width) {
        name = found.name
        break
      }
    }
    blocks.push({
      start: index,
      end,
      stop,
      id: row.id,
      indent: row.indent,
      width,
      name,
      parent: parentIndexOf(lines, index),
    })
  }
  return blocks
}

/** 某个 `- id: <id>` 插件项的完整区间（不限缩进）；`end` 是下一兄弟/父级的起点。 */
function sectionRange(lines, id) {
  const block = pluginBlocks(lines).find((item) => item.id === id)
  return block === undefined ? undefined : { start: block.start, end: block.stop }
}

/**
 * 造一个「问运行时」的对象：能解析哪些 specifier、包的入口源码长什么样。
 * @param {string} runtimeDirectory 便携版 app/，或桌面版 resources/app.asar/dsh
 */
export function createRuntime(runtimeDirectory) {
  // 必须先 resolve：update.exe 传进来的 --runtime 可能是相对的（CI 冒烟用的是 portable\app），
  // createRequire 只吃绝对路径或 file URL，相对路径会直接抛
  // "The argument 'filename' must be ... an absolute path string"。
  const require = createRequire(join(resolve(runtimeDirectory), 'package.json'))
  const sources = new Map()

  /** 这个 specifier 在当前运行时里能解析吗。 */
  function resolvable(specifier) {
    try {
      require.resolve(specifier)
      return true
    } catch {
      return false
    }
  }

  /**
   * 包入口源码（已构建的 lib/index.js 之类），用来确认某个 config 字段上游还认不认。
   * 读不到返回 undefined —— 调用方必须把它当作「判断不了」，不是「没有」。
   */
  function sourceOf(name) {
    if (sources.has(name)) return sources.get(name)
    let manifestPath
    try {
      manifestPath = require.resolve(name + '/package.json')
    } catch {
      sources.set(name, undefined)
      return undefined
    }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      sources.set(name, undefined)
      return undefined
    }
    const directory = dirname(manifestPath)
    const candidates = [manifest.main, 'lib/index.js', 'dist/index.js'].filter((entry) => typeof entry === 'string')
    let text
    for (const candidate of candidates) {
      try {
        text = readFileSync(join(directory, candidate), 'utf8')
        break
      } catch {
        // 换下一个候选
      }
    }
    sources.set(name, text)
    return text
  }

  return { resolvable, sourceOf }
}
/**
 * 把 modelSelectionSettings 换成上游 dev 版认的三个键。
 * 为什么三个一起写：schemastery 对未知键宽松合并，两版 schema 都能读到各自要的那个，
 * 于是同一份配置在 stable 与 dev 下都生效，以后不用再改。
 */
function migrateModelSelection(lines, changes) {
  const has = (from, key, indent) => {
    for (let index = from; index < lines.length; index++) {
      const line = lines[index]
      if (line.trim() === '' || rowId(line) !== undefined) return false
      const row = rowKey(line, key)
      if (row !== undefined && row.indent === indent) return true
    }
    return false
  }
  const out = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const row = rowKey(line, 'modelSelectionSettings')
    if (row === undefined) {
      out.push(line)
      continue
    }
    const value = row.value === '' ? 'true' : row.value
    out.push(row.indent + 'modelSelectionSettings: ' + value)
    // 幂等：上一轮已经补过的键不再追加（这一行本身是保留的，所以每次都会再扫到）。
    const missing = ['modelSelection', 'modelDiscovery'].filter(key => !has(index + 1, key, row.indent))
    for (const key of missing) out.push(row.indent + key + ': ' + value)
    if (missing.length === 0) continue
    changes.push({ kind: 'model-selection', detail: 'modelSelectionSettings: ' + value + ' → 补 ' + missing.join(' / ') })
  }
  return out
}

/**
 * 删掉当前运行时的包已经不认的 config 键（逐行）。
 *
 * 序列项有两种写法：`- key: value`（标记与首键同行）和 `-` 独占一行。前者被删掉首键时，
 * 标记会跟着一起去见上帝，剩下的兄弟键就掉进上一层的映射里 —— 上游 schema 于是报
 * `expected array but got [object Object]`，整个插件起不来。所以删掉带标记的首行时，
 * 必须把 `- ` 转交给下一个兄弟键。
 */
/**
 * 修好「整块一个序列标记都没有」的 models 块。
 *
 * 旧版 dropDeadKeys 删掉 "- imagePixelBudget: 640000" 整行时把 "- " 一起带走了，
 * models 于是从数组塌成映射，上游报 "expected array but got [object Object]"。
 * 只动「整块没有任何 "- "」的块 —— 那正是我们自己的迁移造出来的形态；
 * 手工写成映射的配置本来就不合法，交给上游自己去报错。
 */
function repairLostSequenceMarks(lines, range, changes) {
  const out = lines.slice()
  for (let index = range.start; index < out.length && index < range.end; index++) {
    const head = /^([ \t]*)models:[ \t]*$/u.exec(out[index])
    if (head === null) continue
    const childIndent = head[1] + '  '
    let end = index + 1
    let marked = false
    let first
    while (end < out.length && end < range.end) {
      const line = out[end]
      if (line.trim() === '' || !line.startsWith(childIndent)) break
      // 只看 models 的直接子键：input: 下面的 "- text" 也是列表项，但它缩进更深，
      // 不能拿来证明 models 自己是数组（这正是第一版漏判的原因）。
      const indentLength = line.length - line.trimStart().length
      if (indentLength === childIndent.length) {
        if (/^[ \t]*-[ \t]/u.test(line)) marked = true
        if (first === undefined) first = end
      }
      end++
    }
    // 没坏（本来就有标记），或者块是空的（没有内容行要修）
    if (marked || first === undefined) continue
    out[first] = head[1] + '- ' + out[first].slice(childIndent.length)
    changes.push({ kind: 'model-list', detail: '补回 models 的序列标记（旧版迁移删首键时把 "- " 一起带走了）' })
    index = end - 1
  }
  return out
}
function dropDeadKeys(lines, keys, changes) {
  const out = []
  /** 被删的 `- key: value` 留下的列表标记缩进，等着转交给下一个兄弟键。 */
  let orphan
  for (const line of lines) {
    const hit = keys.find((key) => rowKey(line, key) !== undefined)
    if (hit !== undefined) {
      changes.push({ kind: 'dead-key', detail: '删除 ' + hit + '（当前运行时的包不认这个字段）' })
      const dash = /^([ \t]*)-[ \t]/u.exec(line)
      if (dash !== null) orphan = dash[1]
      continue
    }
    if (orphan !== undefined) {
      const rest = line.slice(orphan.length)
      // 兄弟键：缩进比标记更深（`  ` + 首键列），自己又不带标记 —— 正好接住这枚标记。
      if (rest.trim() !== '' && rest.startsWith('  ') && !/^[ \t]*-[ \t]/u.test(rest)) {
        out.push(orphan + '- ' + rest.trimStart())
        orphan = undefined
        continue
      }
      // 元素到这里就结束了（空行或退回上一层），标记无处安放，只能丢掉
      orphan = undefined
    }
    out.push(line)
  }
  return out
}

/**
 * 5. 旧 Computer Use provider → `@deepseek-ai/dsh-cua-bundle`。
 *
 * 只认精确包名，且只在「没有任何新链行」时替换。旧配置可能是用户自己写的，猜错就等于
 * 擅自替他换了工具面 —— 所以带自定义 config、显式停用、或已与新链并存的一律不碰，
 * 只留一条 warning。迁移的目标是「让默认链干净」，不是「把用户的选择改掉」。
 */
function migrateComputerUse(lines, changes, warnings) {
  const blocks = pluginBlocks(lines)
  const candidates = blocks.filter((block) => block.name !== undefined && LEGACY_COMPUTER_USE_PROVIDERS.has(block.name))
  if (candidates.length === 0) return lines
  // 只有 (id, name) 都有据可查的旧行才进候选；id 猜错就永远匹配不上真实配置，只诊断不改写。
  const legacy = []
  const foreignId = []
  for (const block of candidates) {
    if (AUTO_MIGRATABLE_LEGACY_ROWS.get(block.name) === block.id) legacy.push(block)
    else foreignId.push(block)
  }
  if (legacy.length === 0) {
    warnings.push({
      kind: 'computer-use',
      detail: `旧 Computer Use provider 的 id 不是发行 id（${foreignId.map((block) => `${block.id} → ${block.name}`).join('、')}）；不自动迁移，保留未动，请人工确认`,
    })
    return lines
  }
  const modern = blocks.find((block) => block.name !== undefined && CUA_PROVIDER_PACKAGES.has(block.name))
  if (modern !== undefined) {
    warnings.push({
      kind: 'computer-use',
      detail: `配置里同时存在旧 Computer Use provider（${legacy.map((block) => block.id).join(', ')}）与新链 ${modern.name}；一个 profile 只能挂一条链，已跳过迁移，请人工确认`,
    })
    return lines
  }
  // 目标 id 必须没被别的插件占着：撞了就会写出两行同 id，cordis 装载直接失败。
  const occupied = blocks.find((block) => block.id === CUA_BUNDLE_ID && !legacy.includes(block))
  if (occupied !== undefined) {
    warnings.push({
      kind: 'computer-use',
      detail: `配置里已经有 id: ${CUA_BUNDLE_ID} 的插件（name ${occupied.name ?? '未知'}），再迁一条会造出重复 id；已跳过迁移，请人工确认`,
    })
    return lines
  }
  // 旧行可能散落在多个父节点（多个 `- insert:` 段）里；每段各写一条 bundle 会造出重复 id。
  const parents = new Set(legacy.map((block) => block.parent))
  if (parents.size > 1) {
    warnings.push({
      kind: 'computer-use',
      detail: `旧 Computer Use provider 分布在 ${parents.size} 个不同的父节点下（${legacy.map((block) => block.id).join(', ')}）；逐个替换会造出重复的 ${CUA_BUNDLE_ID} id，已跳过迁移，请人工确认`,
    })
    return lines
  }
  const movable = []
  const preserved = foreignId.map((block) => ({ block, foreignId: true }))
  for (const block of legacy) {
    const body = lines.slice(block.start, block.end)
    const disabled = body.some((line) => {
      const key = rowKey(line, 'disabled')
      return key !== undefined && key.value === 'true'
    })
    const customized = body.some((line) => rowKey(line, 'config') !== undefined)
    // 只认「历史发行形状」：块里除 id / name 之外还有任何键（priority、enabled、未知参数……）
    // 就不是我们发出去的那一行，不能假设它可以等价搬到新 bundle。
    const unknown = body.some((line) => {
      const match = /^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:/u.exec(line)
      return match !== null && match[1] !== 'id' && match[1] !== 'name'
    })
    // 块里夹了注释，说明用户在那行上写过东西（为什么停用、改过什么）。整块替换会把这些注释一起抹掉，
    // 我们宁可不动它 —— 注释是用户的心智记录，不是可以丢弃的格式噪声。
    const commented = body.some((line) => /^\s*#/u.test(line))
    if (disabled || customized || unknown || commented) preserved.push({ block, disabled, customized, unknown, commented })
    else movable.push(block)
  }
  // 同一父节点里的旧注册表行：新 bundle 的 cordis.patch.yml 自带 cua-provider-registry，
  // 留着就是两份注册表实例。别的段里的、或带自定义字段的，都不猜，交人工确认。
  const registries = []
  for (const block of blocks) {
    if (block.name !== LEGACY_REGISTRY_NAME) continue
    const paired = legacy.some((item) => item.parent === block.parent)
    const body = lines.slice(block.start, block.end)
    const bare = !body.some((line) => {
      if (rowKey(line, 'disabled') !== undefined) return true
      if (rowKey(line, 'config') !== undefined) return true
      const match = /^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:/u.exec(line)
      return match !== null && match[1] !== 'id' && match[1] !== 'name'
    })
    if (paired && bare && LEGACY_REGISTRY_IDS.has(block.id)) registries.push(block)
    else preserved.push({ block, registry: true })
  }
  // 用户显式停用过 CUA：默认启用不能借迁移把他的关闭动作翻回来，整份保持原样。
  if (preserved.some((item) => item.disabled)) {
    warnings.push({
      kind: 'computer-use',
      detail: `旧 Computer Use provider（${preserved.filter((item) => item.disabled).map((item) => item.block.id).join(', ')}）已被显式停用，按用户选择保留且不启用新链`,
    })
    return lines
  }
  if (preserved.some((item) => item.registry === true)) {
    warnings.push({
      kind: 'computer-use',
      detail: `旧注册表行 ${preserved.filter((item) => item.registry === true).map((item) => item.block.id).join(', ')} 不在同一段或不是发行裸形状，无法判断是否该随旧 provider 一起删除；已跳过迁移，请人工确认`,
    })
    return lines
  }
  if (preserved.length > 0) {
    const describe = (item) => {
      if (item.foreignId === true) return `${item.block.id}（id 不是发行 id）`
      if (item.commented === true) return `${item.block.id}（块内带用户注释）`
      if (item.customized === true) return `${item.block.id}（自定义 config）`
      return `${item.block.id}（含非发行键）`
    }
    warnings.push({
      kind: 'computer-use',
      detail: `旧 Computer Use provider ${preserved.map(describe).join('、')} 不是已知发行形状；为避免两条链同时激活或静默改行为，已跳过迁移，请人工确认`,
    })
    return lines
  }
  if (movable.length === 0) return lines
  // 按行号从后往前改，前面的行号才不会漂移。
  const operations = [
    ...movable.map((block, index) => ({ block, replace: index === 0 })),
    ...registries.map((block) => ({ block, registry: true })),
  ].sort((left, right) => right.block.start - left.block.start)
  let result = lines.slice()
  for (const operation of operations) {
    const block = operation.block
    const length = block.end - block.start
    if (operation.replace === true) {
      result.splice(block.start, length, `${block.indent}- id: ${CUA_BUNDLE_ID}`, `${block.indent}  name: '${CUA_BUNDLE}'`)
      changes.push({ kind: 'computer-use', detail: `旧 provider ${block.id} → ${CUA_BUNDLE}（bundle 自带 registry 与平台 provider）` })
    } else if (operation.registry === true) {
      result.splice(block.start, length)
      changes.push({ kind: 'computer-use', detail: `删除旧注册表行 ${block.id}（${LEGACY_REGISTRY_NAME}；新 bundle 自带 cua-provider-registry）` })
    } else {
      // 同一个 provider 被重复挂了两次（复制粘贴常见）：只留一条，避免一个 profile 里两个 provider 抢注册。
      result.splice(block.start, length)
      changes.push({ kind: 'computer-use', detail: `删除重复的旧 provider ${block.id}（一个 profile 只留一条 Computer Use 链）` })
    }
  }
  return result
}

/**
 * 迁移一份 cordis.patch.yml 的文本。
 * @param {string} text 原文
 * @param {{resolvable: (specifier: string) => boolean, sourceOf: (name: string) => string | undefined}} runtime
 * @returns {{text: string, changes: object[], warnings: object[]}}
 */
export function migratePatchText(text, runtime) {
  const { lines, crlf } = splitLines(text)
  const changes = []
  const warnings = []

  // ── 1. list-agents 子路径：新运行时没有这条导出，整行块必须消失 ──────────────────
  //    判据直接问运行时：解析不到就删。上游把它并进主入口后，主入口的 apply() 自己会注册，
  //    所以删掉不会丢功能。
  let current = lines
  if (runtime.resolvable(LIST_AGENTS)) {
    const present = current.some((line) => {
      const row = rowId(line)
      return row !== undefined && row.id === 'tool-subagent-list-agents'
    })
    // 反向：从 dev 回退到 stable 时这行必须回来 —— stable 的主入口不注册 list_agents，
    // 子路径是它唯一的提供者，缺了它 list_agents 工具就直接消失。
    // 插在主入口行之后，保持和上游分组的样子一致。
    if (!present) {
      const anchor = current.findIndex((line) => {
        const row = rowId(line)
        return row !== undefined && row.id === 'tool-subagent-control'
      })
      if (anchor === -1) {
        warnings.push({ kind: 'list-agents', detail: '当前运行时有 /list-agents 子路径，但配置里既没有该行、也没有 tool-subagent-control 主入口行，无法判断插入位置' })
      } else {
        let at = anchor + 1
        if (at < current.length && rowName(current[at]) !== undefined) at++
        // 跳过主入口块与下一行之间的分隔空行，让新块落在空行之后 —— 否则它会紧贴在
        // 上一块的 name 行下面，读起来像同一行的一部分。
        if (at < current.length && current[at].trim() === '') at++
        const indent = rowId(current[anchor])?.indent ?? ''
        const block = [`${indent}- id: tool-subagent-list-agents`, `${indent}  name: '${LIST_AGENTS}'`, '']
        current = current.slice(0, at).concat(block, current.slice(at))
        changes.push({ kind: 'list-agents', detail: '补回 tool-subagent-list-agents 行（当前版本的 list_agents 只由该子路径提供）' })
      }
    }
  } else {
    const kept = []
    for (let index = 0; index < current.length; index++) {
      const row = rowId(current[index])
      if (row === undefined || row.id !== 'tool-subagent-list-agents') {
        kept.push(current[index])
        continue
      }
      // 连带吃掉紧随其后的 name 行与分隔空行
      let end = index + 1
      if (end < current.length && rowName(current[end]) !== undefined) end++
      if (end < current.length && current[end].trim() === '') end++
      changes.push({ kind: 'list-agents', detail: '删除 tool-subagent-list-agents 行（已并入主入口）' })
      index = end - 1
    }
    current = kept
  }

  // ── 2. modelSelectionSettings → 三键共存 ─────────────────────────────────────
  current = migrateModelSelection(current, changes)

  // ── 3. 死键：只删「包的源码里确实没有这个词」的那些 ───────────────────────────
  //    源码读不出来 = 判断不了，保留并回报，不改。
  const subagentSource = runtime.sourceOf(SUBAGENT)
  if (subagentSource === undefined) {
    const suspects = current.some((line) => rowKey(line, 'backgroundMode') !== undefined || rowKey(line, 'enableRunInBackground') !== undefined)
    if (suspects) {
      warnings.push({ kind: 'subagent', detail: '读不到 dsh-tool-subagent 源码，跳过 backgroundMode / enableRunInBackground 的清理' })
    }
  } else {
    const dead = ['backgroundMode', 'enableRunInBackground'].filter((key) => !subagentSource.includes(key))
    if (dead.length > 0) current = dropDeadKeys(current, dead, changes)
  }

  const piAiSource = runtime.sourceOf(PI_AI)
  const piAiRange = sectionRange(current, 'llm-pi-ai')
  if (piAiRange === undefined) {
    // 没有这一节，不用管
  } else if (piAiSource === undefined) {
    warnings.push({ kind: 'pi-ai', detail: '读不到 dsh-llm-pi-ai 源码，跳过图片预算键的清理' })
  } else {
    const dead = ['imagePixelBudget', 'imageMaxBytes'].filter((key) => !piAiSource.includes(key))
    if (dead.length > 0) {
      const head = current.slice(0, piAiRange.start)
      const body = dropDeadKeys(current.slice(piAiRange.start, piAiRange.end), dead, changes)
      current = head.concat(body, current.slice(piAiRange.end))
    }
    // 旧版迁移可能已经把配置写坏了（models 塌成映射），这里顺手修回来
    const afterCleanup = sectionRange(current, 'llm-pi-ai')
    if (afterCleanup !== undefined) current = repairLostSequenceMarks(current, afterCleanup, changes)
  }

  // ── 4. tool-presentation → tool-executor-ptc ──────────────────────────────────
  //    presentation 包在 dev 已标 @deprecated 并改成转发；只有「新运行时能解析 executor-ptc」
  //    且「presentation 已经是弃用转发壳」时才换。stable 没有 executor-ptc，一律不动。
  const presentationSource = runtime.sourceOf(PRESENTATION)
  const canForward = presentationSource !== undefined && presentationSource.includes('@deprecated') && runtime.resolvable(EXECUTOR_PTC)
  // 反向：从 dev 回退到 stable 时 executor-ptc 根本不存在，留着它 = MODULE_NOT_FOUND、预设整组挂不上。
  // 判据同样是「问运行时」：presentation 能解析、executor-ptc 不能，就必须换回去。
  const mustRewind = !runtime.resolvable(EXECUTOR_PTC) && runtime.resolvable(PRESENTATION)
  if (mustRewind) {
    const rewound = []
    for (let index = 0; index < current.length; index++) {
      const row = rowId(current[index])
      const next = index + 1 < current.length ? rowName(current[index + 1]) : undefined
      const hit = row !== undefined && row.id === 'tool-executor-ptc' && next !== undefined && next.name === EXECUTOR_PTC
      if (hit) {
        // 配置里可能本来就留着 presentation 那一行（手写的，或者正向迁移没跑过）。
        // 那种情况下只删 executor 块 —— 再补一份就是同一 scope 里挂两次，
        // 上游会报 "Only one tool executor may be registered in each scope"。
        const already = current.some((line, at) => {
          const row2 = rowId(line)
          return at !== index && row2 !== undefined && row2.id === 'tool-presentation'
        })
        if (already) {
          changes.push({ kind: 'presentation', detail: '删除 tool-executor-ptc 行（配置里已有 tool-presentation；当前运行时没有 executor-ptc）' })
        } else {
          rewound.push(row.indent + '- id: tool-presentation')
          rewound.push(next.indent + "name: '" + PRESENTATION + "'")
          rewound.push(next.indent + 'config:')
          rewound.push(next.indent + '  mode: ptc')
          changes.push({ kind: 'presentation', detail: 'tool-executor-ptc → tool-presentation(mode: ptc)（当前运行时没有 executor-ptc）' })
        }
        index++
        // 吃掉块尾的空行，删干净
        if (index + 1 < current.length && current[index + 1].trim() === '') index++
        continue
      }
      rewound.push(current[index])
    }
    current = rewound
  } else if (canForward) {
    const replaced = []
    for (let index = 0; index < current.length; index++) {
      const row = rowId(current[index])
      const next = index + 1 < current.length ? rowName(current[index + 1]) : undefined
      // config: 与 mode: 之间允许隔着别的键？不允许 —— 只跨过 config: 这一行。
      let modeAt = index + 2
      if (modeAt < current.length && rowKey(current[modeAt], 'config') !== undefined) modeAt++
      const mode = modeAt < current.length ? rowKey(current[modeAt], 'mode') : undefined
      const hit = row !== undefined && row.id === 'tool-presentation' && next !== undefined
        && next.name === PRESENTATION && mode !== undefined && mode.value === 'ptc'
      if (hit) {
        replaced.push(row.indent + '- id: tool-executor-ptc')
        replaced.push(next.indent + "name: '" + EXECUTOR_PTC + "'")
        let end = index + 2
        // 吃掉 config: 与 mode: ptc 两行
        while (end < current.length && /^[ \t]*(?:config:|mode:[ \t]*ptc)[ \t]*$/u.test(current[end])) end++
        changes.push({ kind: 'presentation', detail: 'tool-presentation(mode: ptc) → tool-executor-ptc' })
        index = end - 1
        continue
      }
      replaced.push(current[index])
    }
    current = replaced
  }

  // ── 5. 旧 Computer Use provider → dsh-cua-bundle ─────────────────────────────
  current = migrateComputerUse(current, changes, warnings)

  return { text: current.join(crlf ? '\r\n' : '\n'), changes, warnings }
}

/**
 * 迁移一个 profile 目录里的 cordis.patch.yml。写盘成功才算变更。
 * @returns {{file: string, changed: boolean, changes: object[], warnings: object[]}}
 */
export function migrateProfile(profileDirectory, runtime) {
  const file = join(profileDirectory, 'cordis.patch.yml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, changed: false, changes: [], warnings: [] }
  }
  const result = migratePatchText(text, runtime)
  const changed = result.text !== text
  if (changed) writeFileSync(file, result.text)
  return { file, changed, changes: result.changes, warnings: result.warnings }
}
