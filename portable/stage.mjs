// 便携包 node_modules 后处理（借鉴官方 build-exe-for-python-sdk.ts 的 materializeStagedLinks）
// 作用：把 checkout 里 pnpm install 出的 node_modules 复制到 portable/app/node_modules，
//       并将所有 symlink/junction（workspace 包、link:vendor override 包）替换成真实文件，
//       产出一份完全扁平、无链接、可直接 zip 分发的目录。
// 用法：node stage.mjs <checkout-node_modules> <portable-app-node_modules>

import { cp, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const src = resolve(process.argv[2])
const dst = resolve(process.argv[3])

// 1. 复制整棵 node_modules（保留 symlink，稍后统一 materialize）
console.log(`[stage] copying ${src} -> ${dst}`)
await cp(src, dst, { recursive: true, dereference: false })

// 2. 递归找第一个 symlink（Node 在 Windows 上对 junction 也报告 isSymbolicLink）
async function findSymlink(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    let meta
    try {
      meta = await lstat(p)
    } catch {
      continue
    }
    if (meta.isSymbolicLink()) return p
    if (meta.isDirectory()) {
      const nested = await findSymlink(p)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

// 3. 逐个 materialize：realpath 解析真实位置 → 删掉链接 → 复制真实内容（跳过嵌套 node_modules）
let count = 0
let remaining = await findSymlink(dst)
while (remaining !== undefined) {
  const source = await realpath(remaining)
  const nested = join(source, 'node_modules')
  await rm(remaining, { recursive: true, force: true })
  await cp(source, remaining, {
    recursive: true,
    dereference: true,
    filter: (p) => p !== nested && !p.startsWith(nested + sep),
  })
  count += 1
  if (count % 50 === 0) console.log(`[stage] materialized ${count} links`)
  remaining = await findSymlink(dst)
}
console.log(`[stage] done, materialized ${count} symlinks`)
