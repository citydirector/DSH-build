// 把上游 package.json 钉的 packageManager 对齐到我们要跑的 pnpm，并把版本写进 $GITHUB_OUTPUT。
//
// 版本来源，按优先级：
//   1. 环境变量 PNPM_VERSION —— 人工覆盖，只在紧急钉版时用（会与随包 pnpm 产生偏差，见下）；
//   2. 上游根 package.json 的 devDependencies.pnpm —— 上游自己随包携带的那份；
//   3. 上游根 package.json 的 packageManager 字段。
// 默认走第 2 条：桌面版 primary-runtime 里的 pnpm 就是 scripts/primary-runtime/prepare.ts
// 从上游 devDependencies.pnpm 那份拷进去的，照着它跑，构建用的 pnpm 恒等于用户运行时拿到的 pnpm。
// 从前这里是个手写常量，于是 CI 跑 11.27.1、随包却是 11.28.5 —— 两个版本各自演进，迟早对不上。
//
// 第 1 条只在需要时用：改 PNPM_VERSION 不会改 devDependencies.pnpm（改了会让 --frozen-lockfile
// 因 lockfile 里的 specifier 不匹配而失败），所以覆盖之后两者必然不同版本，脚本会明确警告。
//
// 禁区（命中即 exit 2，宁可构建失败也不悄悄跑一个没验证过的 pnpm）：
//   < 11.7.1  —— 11.7.0 有 hoisted 缺陷 pnpm#12880（整目录替换会静默删掉并发兄弟的 _tmp_*）；
//   >= 12     —— 12.x 在工作区里跑 `pnpm run/exec` 必失败（内部那次依赖校验安装带上了已被
//                自己移除的 verify-deps-before-run-install，外部 --config 覆盖救不了）。
//
// 用法（工作目录 = 上游检出根）：node _build_repo/ci/align-package-manager.mjs
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

export const FLOOR = '11.7.1'
export const CEILING_MAJOR = 12

/** 解析 x.y.z（接受预发布后缀），失败返回 undefined。 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** 三段比较。 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

/** 版本是否落在允许区间内。 */
export function isAllowed(version) {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  return compareVersions(parsed, parseVersion(FLOOR)) >= 0 && parsed[0] < CEILING_MAJOR
}

/**
 * 从三种来源里决定要跑的 pnpm 版本。
 * @param {{ override?: string, declared?: string, pinned?: string }} candidates - 已 trim 过的候选值。
 * @returns {{ version: string, source: string, overridden: boolean } | { error: string }}
 */
export function pickPnpmVersion(candidates) {
  const override = (candidates.override ?? '').trim()
  const declared = (candidates.declared ?? '').trim()
  const pinned = (candidates.pinned ?? '').trim()
  const version = override !== '' ? override : declared !== '' ? declared : pinned
  const source = override !== '' ? 'PNPM_VERSION' : declared !== '' ? 'devDependencies.pnpm' : pinned !== '' ? 'packageManager' : ''
  if (version === '') {
    return { error: '上游 package.json 里既没有 devDependencies.pnpm 也没有 packageManager；请设 PNPM_VERSION 显式指定' }
  }
  if (parseVersion(version) === undefined) return { error: `无法解析 pnpm 版本 '${version}'（来自 ${source}）` }
  if (!isAllowed(version)) {
    return { error: `pnpm ${version}（来自 ${source}）落在禁区内：需 >=${FLOOR} 且 <${CEILING_MAJOR}。`
      + ' <11.7.1 有 hoisted 缺陷 pnpm#12880，12.x 在工作区跑 pnpm run 会失败' }
  }
  return { version, source, overridden: override !== '' && declared !== '' && override !== declared }
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const picked = pickPnpmVersion({
    override: process.env.PNPM_VERSION,
    declared: typeof manifest.devDependencies?.pnpm === 'string' ? manifest.devDependencies.pnpm : '',
    pinned: typeof manifest.packageManager === 'string' ? manifest.packageManager.replace(/^pnpm@/u, '') : '',
  })
  if ('error' in picked) { console.error('align-package-manager: ' + picked.error); process.exit(2) }
  if (picked.overridden) {
    console.error(`align-package-manager: 警告 —— PNPM_VERSION=${picked.version} 覆盖了上游 devDependencies.pnpm，`
      + '构建用的 pnpm 将与随包 pnpm 不同版本')
  }
  manifest.packageManager = `pnpm@${picked.version}`
  writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
  // 供 pnpm/action-setup 直接消费：版本只有一个来源，workflow 里不再出现手写常量。
  const output = process.env.GITHUB_OUTPUT
  if (output !== undefined && output !== '') appendFileSync(output, `pnpm_version=${picked.version}\n`)
  console.log(`${manifest.packageManager} (from ${picked.source})`)
}
