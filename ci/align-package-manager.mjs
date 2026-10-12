// 把上游 package.json 钉的 packageManager 对齐到我们要跑的 pnpm（$PNPM_VERSION）。
// 不对齐的话 pnpm 会自动回退到上游钉的版本（11.7.0 有 hoisted 缺陷 pnpm#12880）。
// 用法（工作目录 = 上游检出根）：node _build_repo/ci/align-package-manager.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.env.PNPM_VERSION
if (!version) { console.error('align-package-manager: PNPM_VERSION 未设置'); process.exit(2) }
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
manifest.packageManager = `pnpm@${version}`
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(manifest.packageManager)
