// 对 deploy 产物的 node_modules 做 materialize：把所有 symlink/junction 替换成真实文件。
// 用法：node materialize.mjs <deploy-node_modules>

import { cp, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const dst = resolve(process.argv[2])

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
console.log(`[materialize] found ${links.length} symlinks`)

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
  if (count % 50 === 0) console.log(`[materialize] ${count}/${links.length}`)
}
console.log(`[materialize] done, ${count} symlinks`)
