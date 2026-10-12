// portable/lib/apply-edits.mjs —— 源码补丁共用的「锚点替换」原语。
//
// 每个补丁脚本只声明 EDITS，规则统一在这里：
//   - 幂等：文件里已经有 `to`，跳过这一条；
//   - 严格：`from` 必须恰好命中 1 次，0 次或多次都直接抛错（宁可构建失败，也不静默出半补丁的包）；
//   - 多形状：`from` 可以是数组，表示上游先后出现过的几种写法；必须恰好有一种命中 1 次、其余为 0；
//   - 替换用函数形式，`to` 里的 `$&` / `$1` 之类不会被 String.prototype.replace 解释。
//
// edit 的形状：{ name: string, file?: string, from: string | string[], to: string }
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 统计 needle 在 haystack 中出现的次数（不重叠）。
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
export function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * 对一段文本依次应用编辑。
 * @param {string} text - 原文。
 * @param {Array<{name: string, from: string | string[], to: string}>} edits - 编辑列表。
 * @param {string} label - 报错前缀（通常是补丁脚本名）。
 * @param {string} [where] - 报错里的位置（文件相对路径）。
 * @returns {{ text: string, applied: string[] }} 结果文本与本次实际写入的编辑名。
 */
export function applyEditsToText(text, edits, label, where) {
  const at = where === undefined ? '' : ` in ${where}`
  let out = text
  const applied = []
  for (const edit of edits) {
    if (out.includes(edit.to)) continue
    const shapes = Array.isArray(edit.from) ? edit.from : [edit.from]
    const counts = shapes.map((from) => countOccurrences(out, from))
    const hits = shapes.filter((_, i) => counts[i] === 1)
    if (hits.length !== 1 || counts.some((n) => n > 1)) {
      const found = shapes.length === 1 ? String(counts[0]) : `[${counts.join(', ')}]`
      const what = shapes.length === 1 ? 'exactly 1 occurrence' : 'exactly 1 occurrence of one known shape'
      throw new Error(`${label}: ${edit.name}: expected ${what}${at}, found ${found}`)
    }
    out = out.replace(hits[0], () => edit.to)
    applied.push(edit.name)
  }
  return { text: out, applied }
}

/**
 * 按 edit.file 分组，就地修改 root 下的文件。
 * @param {string} root - 仓库根目录。
 * @param {Array<{name: string, file: string, from: string | string[], to: string}>} edits
 * @param {string} label - 报错前缀。
 * @returns {{ applied: string[] }}
 */
export function applyEditsToFiles(root, edits, label) {
  const files = [...new Set(edits.map((edit) => edit.file))]
  const applied = []
  for (const file of files) {
    const path = join(root, file)
    const raw = readFileSync(path, 'utf8')
    const result = applyEditsToText(raw, edits.filter((edit) => edit.file === file), label, file)
    if (result.applied.length > 0) writeFileSync(path, result.text)
    applied.push(...result.applied)
  }
  return { applied }
}

/** 所有编辑的 `to` 都已在对应文件中。 */
export function editsApplied(root, edits) {
  return edits.every((edit) => readFileSync(join(root, edit.file), 'utf8').includes(edit.to))
}
