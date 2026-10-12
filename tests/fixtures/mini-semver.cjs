// 测试用的极简 semver：只覆盖 plugin-refresh 测试里出现的写法（精确版本、比较符组合、^）。
// 真实运行时用的是新运行时自带的 semver；本地可设 DSH_TEST_SEMVER=<semver 包路径> 换成真实实现交叉验证。
'use strict'
const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parse(version) {
  const match = PATTERN.exec(String(version).trim())
  if (match === null) return null
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split('.') : [] }
}

function valid(version) {
  const parsed = parse(version)
  return parsed === null ? null : `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.pre.length ? `-${parsed.pre.join('.')}` : ''}`
}

function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(+a - +b)
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compare(a, b) {
  const x = parse(a)
  const y = parse(b)
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return Math.sign(x[key] - y[key])
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1
    if (y.pre[i] === undefined) return 1
    const c = compareIdentifiers(x.pre[i], y.pre[i])
    if (c !== 0) return c
  }
  return 0
}

function satisfies(version, range) {
  if (parse(version) === null) return false
  const text = String(range).trim()
  if (text.startsWith('^')) {
    const base = parse(text.slice(1))
    if (base === null) return false
    const upper = base.major > 0 ? `${base.major + 1}.0.0-0` : base.minor > 0 ? `0.${base.minor + 1}.0-0` : `0.0.${base.patch + 1}-0`
    return compare(version, text.slice(1)) >= 0 && compare(version, upper) < 0
  }
  for (const part of text.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part)
    if (match === null || parse(match[2]) === null) return false
    const c = compare(version, match[2])
    const ok = { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0, undefined: c === 0 }[match[1]]
    if (!ok) return false
  }
  return true
}

module.exports = {
  valid,
  satisfies,
  gt: (a, b) => compare(a, b) > 0,
  rcompare: (a, b) => compare(b, a),
  prerelease: version => { const parsed = parse(version); return parsed && parsed.pre.length ? parsed.pre : null },
}
