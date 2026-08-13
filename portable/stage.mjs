// 便携包 node_modules 后处理（借鉴官方 materializeStagedLinks，但一次性收集链接，避免 O(n²)）
// 把 checkout 里 pnpm install 出的 node_modules 复制到 portable/app/node_modules，
// 并将所有 symlink/junction（workspace 包、link:vendor override 包）替换成真实文件，
// 产出一份完全扁平、无链接、可直接 zip 分发的目录。
// 用法：node stage.mjs <checkout-node_modules> <portable-app-node_modules>

import { cp, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const src = resolve(process.argv[2])
const dst = resolve(process.argv[3])

// 1. 复制整棵 node_modules（保留 symlink）
console.log(`[stage] copying ${src} -> ${dst}`)
await cp(src, dst, { recursive: true, dereference: false })

// 2. 一次性递归收集所有 symlink（Node 在 Windows 上对 junction 也报告 isSymbolicLink）
async function collectSymlinks(dir, acc) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    let meta
    try {
      meta = await lstat(p)
    } catch {
      continue
    }
    if (meta.isSymbolicLink()) {
      acc.push(p)
    } else if (meta.isDirectory()) {
      await collectSymlinks(p, acc)
    }
  }
  return acc
}

const links = await collectSymlinks(dst, [])
console.log(`[stage] found ${links.length} symlinks`)

// 3. 逐个 materialize：realpath 解析真实位置 → 删链接 → 复制真实内容（跳过嵌套 node_modules 避免膨胀）
let count = 0
for (const link of links) {
  const source = await realpath(link)
  const nested = join(source, 'node_modules')
  await rm(link, { recursive: true, force: true })
  await cp(source, link, {
    recursive: true,
    dereference: true,
    filter: (p) => p !== nested && !p.startsWith(nested + sep),
  })
  count += 1
  if (count % 50 === 0) console.log(`[stage] materialized ${count}/${links.length}`)
}
console.log(`[stage] done, materialized ${count} symlinks`)
