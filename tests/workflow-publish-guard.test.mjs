// .github/workflows/build-harness.yml 的发布守卫断言（node:test，零依赖，纯文本解析）。
// 运行: node tests/workflow-publish-guard.test.mjs
//
// 为什么是文本解析而不是 YAML 库：本仓零依赖（Node >= 24 只用 node:test + node:assert），
// 而这里要钉死的只有两件事 —— release 在非发布分支上必须拒绝执行（否则 feat 分支的
// workflow_dispatch 会覆盖 dsh-dev-latest / dsh-master-latest 资产，并让 advance-pin.sh
// 往分支推 pin），以及失败通知不能因为 release 被跳过而漏报。为一个两级缩进的判断
// 引入 YAML 依赖不划算，反而多一个上游变更面。
//
// 关闭开关：没有。这不是可选加固 —— 守卫一旦消失，本仓的 feature 分支首跑就会真发布。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'build-harness.yml')
const LINES = readFileSync(WORKFLOW, 'utf8').split(/\r?\n/u)

/** 按两级缩进的 job 头切出一段，返回该 job 的原始行。 */
function jobLines(name) {
  const start = LINES.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `build-harness.yml 里找不到 job: ${name}`)
  let end = start + 1
  while (end < LINES.length && !/^ {2}[A-Za-z][\w-]*:$/u.test(LINES[end])) end += 1
  return LINES.slice(start, end)
}

/** 取 job 顶层的 `<key>: value`，没有就返回 undefined。 */
function jobField(name, key) {
  const prefix = `    ${key}: `
  const line = jobLines(name).find(item => item.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length)
}

test('release 的 if 只在 main / dev 上放行', () => {
  const condition = jobField('release', 'if')
  assert.equal(typeof condition, 'string', 'release job 必须显式声明 if')
  assert.match(condition, /needs\.check\.outputs\.skip != 'true'/u)
  assert.match(condition, /github\.ref_name == 'main'/u)
  assert.match(condition, /github\.ref_name == 'dev'/u)
  // 两个分支必须在同一个 &&(...) 里 —— 只用 || 拼会丢掉 skip 判断。
  assert.match(condition, /&&\s*\(?[^|]*github\.ref_name == 'main'[^|]*\|\|[^|]*github\.ref_name == 'dev'/u)
  assert.doesNotMatch(condition, /always\(/u)
})

test('发布动作只存在于 release job 内', () => {
  const release = jobLines('release')
  for (const script of ['ci/release/publish.sh', 'ci/release/advance-pin.sh']) {
    const total = LINES.filter(line => line.includes(script)).length
    const inside = release.filter(line => line.includes(script)).length
    assert.ok(total > 0, `${script} 应当仍在流程里`)
    assert.equal(total, inside, `${script} 只能从 release job 调用（全文 ${total} 次，release 内 ${inside} 次）`)
  }
})

test('release 被跳过时失败通知仍然会跑', () => {
  const needs = jobField('notify-failure', 'needs')
  assert.equal(typeof needs, 'string', 'notify-failure 必须声明 needs')
  assert.match(needs, /\brelease\b/u, 'notify-failure 的 needs 必须含 release（它自己失败也要报）')
  assert.equal(jobField('notify-failure', 'if'), 'failure()', 'notify-failure 的判定条件不应改动')
})

test('回退通知与发布分支无关', () => {
  assert.equal(jobField('notify-regressed', 'needs'), '[check]')
  assert.equal(jobField('notify-regressed', 'if'), "needs.check.outputs.regressed == 'true'")
})
