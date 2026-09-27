// 运行: node tests/repair-windows-acl-runner-console.test.mjs
// 覆盖: 夹具改写（含「分配控制台必须在受限 spawn 之前」的顺序断言）/ 幂等 / 上游漂移要报错 /
//       树里找不到包要报错 / 0xC0000142 变成可分类的 runner 失败 / koffi 缺失要给出可读失败 /
//       asar 重打包的结构与字节保真 + 幂等。
//
// 说明: AllocConsole 的真实效果只能在 GUI 子系统的宿主（Electron）里观察，而仓库测试跑在
// console 子系统的 node 上，因此这里只做文本与行为契约。该效果在 Electron 宿主下另有实测：
// windowsHide（= CREATE_NO_WINDOW，即真实链路的条件）下，未分配控制台时受限子进程
// exit 0xC0000142 且 stderr 为空，分配后 exit 0、stdout 正常透传、std 句柄不变。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCHER = join(HERE, '..', 'portable', 'repair-windows-acl-runner-console.mjs')
const NODE = process.execPath

/** 夹具必须逐字带上真实构建产物里的锚点，否则补丁会（正确地）拒绝改写。 */
const RUNNER_FIXTURE = `const RUNNER_SIGNATURE = "windows-acl-run";
const RUNNER_FAILURE_EXIT = 127;
var RunnerFailure = class extends Error {};
function fail(detail) {
\tprocess.stderr.write(RUNNER_SIGNATURE + ": " + detail + "\\n");
\tthrow new RunnerFailure(detail);
}
async function run(sandbox) {
\tawait sandbox.init();
\tconst child = sandbox.spawn({
\t\tcommand: "cmd.exe",
\t\targs: [],
\t\tstdio: "inherit"
\t});
\treturn (await child.wait()).exitCode;
}
`
const SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js']

function plant(root, source = RUNNER_FIXTURE) {
  const file = join(root, ...SEGMENTS)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source)
  return file
}

function run(...args) {
  return spawnSync(NODE, [PATCHER, ...args], { encoding: 'utf8', timeout: 120000 })
}

async function load(file) {
  return import(pathToFileURL(file).href + '?v=' + String(Math.random()))
}

/** 夹具不导出注入的符号（否则补丁会当成「已打过」）；改完再补一行导出。 */
function expose(file, names) {
  writeFileSync(file, readFileSync(file, 'utf8') + `\nexport { ${names.join(', ')} };\n`)
}

//#region 最小 asar 读写器（独立于补丁脚本，用来交叉验证它写出的归档）
/** 按 asar 的 pickle 布局拼一张归档；files 是「归档内相对路径 -> Buffer」。 */
function buildAsar(files) {
  const root = { files: {} }
  for (const [path, buffer] of files) {
    const parts = path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts.at(-1)] = { size: buffer.length }
  }
  const blocks = []
  let offset = 0
  // 按头顺序铺 offset：asar 的数据块背靠背，没有对齐填充。
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files)) {
      const path = prefix === '' ? name : prefix + '/' + name
      if (entry.files !== undefined) { walk(entry, path); continue }
      entry.offset = String(offset)
      offset += entry.size
      blocks.push(files.get(path))
    }
  }
  walk(root, '')
  const json = Buffer.from(JSON.stringify(root), 'utf8')
  const headerSize = Math.ceil(json.length / 4) * 4 + 8
  const headerPickle = Buffer.alloc(headerSize)
  headerPickle.writeUInt32LE(headerSize - 4, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerSize, 4)
  return Buffer.concat([sizePickle, headerPickle, ...blocks])
}
/** 读一张归档的成员（独立实现，只认本测试自己写的归档）。 */
function readAsarMember(archive, path) {
  const headerSize = archive.readUInt32LE(4)
  const jsonSize = archive.readUInt32LE(12)
  const header = JSON.parse(archive.toString('utf8', 16, 16 + jsonSize))
  let node = header
  for (const part of path.split('/')) node = node.files[part]
  const base = 8 + headerSize
  return archive.subarray(base + Number(node.offset), base + Number(node.offset) + Number(node.size))
}
//#endregion

const roots = []
try {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acl-console-'))
  roots.push(root)
  const file = plant(root)

  // 1. 首次改写
  const first = run(root)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /patched=1 already=0/, first.stdout)
  const patched = readFileSync(file, 'utf8')
  assert.match(patched, /ensureSharedConsole/, 'the helper must be injected')
  assert.match(patched, /await ensureSharedConsole\(\);/)
  assert.match(patched, /if \(!allocConsole\(\)\)/)
  assert.match(patched, /ShowWindow/)
  assert.match(patched, /STATUS_DLL_INIT_FAILED/)
  assert.ok(
    patched.indexOf('await ensureSharedConsole();') < patched.indexOf('const child = sandbox.spawn({'),
    'the console must be ensured BEFORE the restricted spawn',
  )
  assert.doesNotMatch(patched, /^[ \t]*return \(await child\.wait\(\)\)\.exitCode;$/mu, 'the raw passthrough must be gone')

  // 2. 幂等
  const second = run(root)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /patched=0 already=1/, second.stdout)

  // 3. 行为：0xC0000142 变成可分类的 runner 失败（签名 + RunnerFailure），普通退出码原样透传。
  //    临时夹具里没有 koffi，所以先关掉控制台分配，好让流程走到 spawn/wait。
  expose(file, ['run', 'fail', 'RunnerFailure', 'ensureSharedConsole', 'STATUS_DLL_INIT_FAILED'])
  const acl = await load(file)
  process.env.DSH_ACL_SHARED_CONSOLE = '0'
  const captured = []
  const realWrite = process.stderr.write
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true }
  try {
    await assert.rejects(() => acl.run({ init: async () => {}, spawn: () => ({ wait: async () => ({ exitCode: 0xC0000142 }) }) }), (error) => error instanceof acl.RunnerFailure)
    await assert.rejects(() => acl.run({ init: async () => {}, spawn: () => ({ wait: async () => ({ exitCode: 0xC0000142 | 0 }) }) }), (error) => error instanceof acl.RunnerFailure)
  } finally {
    process.stderr.write = realWrite
  }
  assert.ok(captured.some((line) => line.startsWith('windows-acl-run: ') && line.includes('STATUS_DLL_INIT_FAILED')), captured.join(''))
  assert.equal(await acl.run({ init: async () => {}, spawn: () => ({ wait: async () => ({ exitCode: 0 }) }) }), 0)
  assert.equal(await acl.run({ init: async () => {}, spawn: () => ({ wait: async () => ({ exitCode: 2 }) }) }), 2)

  // 4. 行为：koffi 不可用（临时夹具目录里没有它）要给出可读的 runner 失败，而不是裸栈
  delete process.env.DSH_ACL_SHARED_CONSOLE
  const quiet = []
  process.stderr.write = (chunk) => { quiet.push(String(chunk)); return true }
  try {
    if (process.platform === 'win32') {
      await assert.rejects(() => acl.ensureSharedConsole(), (error) => {
        assert.ok(error instanceof acl.RunnerFailure, 'koffi failure must be a RunnerFailure')
        assert.match(String(error.message), /koffi is unavailable/)
        return true
      })
    } else {
      await acl.ensureSharedConsole()
    }
  } finally {
    process.stderr.write = realWrite
  }
  // 5. 行为：显式关闭开关时直接返回（不碰 koffi）
  process.env.DSH_ACL_SHARED_CONSOLE = '0'
  await acl.ensureSharedConsole()
  delete process.env.DSH_ACL_SHARED_CONSOLE

  // 6. 上游漂移要报错
  const drifted = mkdtempSync(join(tmpdir(), 'dsh-acl-console-drift-'))
  roots.push(drifted)
  plant(drifted, RUNNER_FIXTURE.replace('const child = sandbox.spawn({', 'const spawned = sandbox.spawn({'))
  const third = run(drifted)
  assert.notEqual(third.status, 0, 'a moved spawn anchor must fail loudly')
  assert.match(third.stderr, /surface changed upstream/)

  // 7. 树里找不到包要报错
  const empty = mkdtempSync(join(tmpdir(), 'dsh-acl-console-empty-'))
  roots.push(empty)
  const fourth = run(empty)
  assert.notEqual(fourth.status, 0, 'a tree without the package must fail loudly')
  assert.match(fourth.stderr, /no deployed/)

  // 7b. 仓库形状：目录名与包名不同，靠 package.json 的 name 识别
  const repoShaped = mkdtempSync(join(tmpdir(), 'dsh-acl-console-repo-'))
  roots.push(repoShaped)
  const renamed = join(repoShaped, 'packages', 'windows-acl')
  mkdirSync(join(renamed, 'lib'), { recursive: true })
  writeFileSync(join(renamed, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sandbox-windows-acl', version: '0.0.0' }))
  writeFileSync(join(renamed, 'lib', 'runner.js'), RUNNER_FIXTURE)
  const fifth = run(repoShaped)
  assert.equal(fifth.status, 0, fifth.stderr)
  assert.match(fifth.stdout, /patched=1 already=0/, fifth.stdout)
  assert.match(readFileSync(join(renamed, 'lib', 'runner.js'), 'utf8'), /ensureSharedConsole/)

  // 8. asar 重打包：结构保真 + 只改被点名的成员
  const asarRoot = mkdtempSync(join(tmpdir(), 'dsh-acl-console-asar-'))
  roots.push(asarRoot)
  const member = 'dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js'
  const untouchedKey = 'dsh/node_modules/plain-package/lib/index.js'
  const members = new Map([
    ['dsh/package.json', Buffer.from('{"name":"@deepseek-ai/dsh","version":"0.0.0-test"}\n', 'utf8')],
    [untouchedKey, Buffer.from('export const value = 1;\n', 'utf8')],
    [member, Buffer.from(RUNNER_FIXTURE, 'utf8')],
  ])
  const input = join(asarRoot, 'app.asar')
  const output = join(asarRoot, 'app.patched.asar')
  writeFileSync(input, buildAsar(members))
  const asarRun = run('--asar', input, output)
  assert.equal(asarRun.status, 0, asarRun.stderr)
  assert.match(asarRun.stdout, /asar patched=1 verified/)
  const written = readFileSync(output)
  assert.match(readAsarMember(written, member).toString('utf8'), /ensureSharedConsole/)
  assert.deepEqual(readAsarMember(written, untouchedKey), members.get(untouchedKey), 'an untouched member must keep its bytes')
  assert.deepEqual(readAsarMember(written, 'dsh/package.json'), members.get('dsh/package.json'))

  // 9. asar 幂等：第二次跑应当没有可改成员（脚本此时仍写出保真副本）
  const twice = join(asarRoot, 'app.twice.asar')
  const again = run('--asar', output, twice)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /asar patched=0 verified/)
  assert.deepEqual(readFileSync(twice), readFileSync(output), 'a no-op repack must be byte-identical')

  console.log('repair-windows-acl-runner-console.test: ok')
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
