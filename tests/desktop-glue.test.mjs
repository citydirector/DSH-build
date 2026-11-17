// 桌面产物的 GLUE 连接点断言（node:test，零依赖，纯文本解析）。
// 只钉三件事：构建会写、验收会查、流水线会传。GLUE 是「上游提交号没动、只有本仓内容变了」
// 的唯一信使；缺任何一环，桌面通道的更新就只能跟着上游提交号走，本仓的修复送不到已装机器。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = readFileSync(join(ROOT, 'portable', 'build-desktop.mjs'), 'utf8')
const VERIFY = readFileSync(join(ROOT, 'portable', 'verify-desktop.mjs'), 'utf8')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'build-harness.yml'), 'utf8').split(/\r?\n/u)

/** 按两级缩进的 job 头切出一段，返回该 job 的原始行。 */
function jobLines(name) {
  const start = WORKFLOW.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `build-harness.yml 里找不到 job: ${name}`)
  let end = start + 1
  while (end < WORKFLOW.length && !/^ {2}[A-Za-z][\w-]*:$/u.test(WORKFLOW[end])) end += 1
  return WORKFLOW.slice(start, end)
}

test('build-desktop 把 DSH_GLUE 写进包根', () => {
  assert.match(BUILD, /process\.env\.DSH_GLUE/u)
  assert.match(BUILD, /writeFileSync\(join\(STAGE, 'GLUE'\)/u)
})

test('CI 缺少 DSH_GLUE 时构建直接失败', () => {
  assert.match(BUILD, /process\.env\.GITHUB_ACTIONS/u)
  assert.match(BUILD, /DSH_GLUE is required in CI/u)
})

test('verify-desktop 检查 GLUE 随包且与构建一致', () => {
  assert.match(VERIFY, /join\(stage, 'GLUE'\)/u)
  assert.match(VERIFY, /process\.env\.DSH_GLUE/u)
  assert.match(VERIFY, /GLUE matches the build glue/u)
})

test('desktop 作业把 check 的 glue 传给构建', () => {
  const lines = jobLines('desktop')
  const envIndex = lines.findIndex(line => line === '    env:')
  assert.notEqual(envIndex, -1, 'desktop job 必须声明 job 级 env')
  const entry = lines.slice(envIndex + 1).find(line => line.startsWith('      DSH_GLUE: '))
  assert.equal(entry, '      DSH_GLUE: ${{ needs.check.outputs.glue }}')
})
