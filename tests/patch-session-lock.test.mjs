// 运行: node tests/patch-session-lock.test.mjs
// 覆盖: 夹具改写 / 幂等 / 上游漂移要报错 / 「同一文件两种拼法」在补丁前后必须从不同名字变成一个名字。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCHER = join(HERE, '..', 'portable', 'patch-session-lock.mjs')
const BT = '`'
const MARKER = 'dsh-session-lock-$' + '{'
const UNPATCHED = 'update(resolve(path).toLowerCase()).digest("hex")'

const FIXTURE = [
  "import { createHash } from 'node:crypto'",
  "import { basename, dirname, join, resolve } from 'node:path'",
  "import { realpath } from 'node:fs/promises'",
  '',
  'export async function lockName(path) {',
  '  return ' + BT + 'Local\\dsh-session-lock-' + MARKER + 'createHash("sha256").' + UNPATCHED + '}' + BT,
  '}',
  '',
  'async function acquireLockHandleWin32(path) { return path }',
  '',
].join('\n')

const SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js']

function plant(root, source, segments = SEGMENTS) {
  const file = join(root, ...segments)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source)
  return file
}

async function lockName(file, path) {
  const url = pathToFileURL(file).href + '?v=' + Math.random()
  return (await import(url)).lockName(path)
}

function run(target) {
  return spawnSync(process.execPath, [PATCHER, target], { encoding: 'utf8' })
}

const root = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
try {
  const file = plant(root, FIXTURE)
  const real = join(root, 'real')
  const link = join(root, 'link')
  mkdirSync(real, { recursive: true })
  const junction = process.platform === 'win32'
  if (junction) symlinkSync(real, link, 'junction')
  const spelling = (base) => join(base, 'session.lock')

  const before = await lockName(file, spelling(real))
  if (junction) {
    const beforeLink = await lockName(file, spelling(link))
    assert.notEqual(before, beforeLink, 'stock spelling must differ through a junction')
  } else {
    console.log('skip: the junction half of this test is Windows-only')
  }

  const first = run(root)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /patched=1/, first.stdout)

  const after = await lockName(file, spelling(real))
  if (junction) {
    assert.equal(after, await lockName(file, spelling(link)), 'canonical path must yield one lock name')
  }

  const second = run(root)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /patched=0 already=1/, second.stdout)

  const drifted = mkdtempSync(join(tmpdir(), 'dsh-lock-drift-'))
  try {
    plant(drifted, FIXTURE.replace(UNPATCHED, 'update(path).digest("hex")'))
    const third = run(drifted)
    assert.notEqual(third.status, 0, 'a moved lock surface must fail loudly')
    assert.match(third.stderr, /changed upstream/)
  } finally { rmSync(drifted, { recursive: true, force: true }) }

  const empty = mkdtempSync(join(tmpdir(), 'dsh-lock-empty-'))
  try {
    const fourth = run(empty)
    assert.notEqual(fourth.status, 0, 'a tree without the package must fail loudly')
    assert.match(fourth.stderr, /not found/)
  } finally { rmSync(empty, { recursive: true, force: true }) }

  const repoShape = mkdtempSync(join(tmpdir(), 'dsh-lock-repo-'))
  try {
    plant(repoShape, FIXTURE, ['packages', 'session', 'dsh-session-persistence-jsonl', 'lib', 'index.js'])
    const fifth = run(repoShape)
    assert.equal(fifth.status, 0, fifth.stderr)
    assert.match(fifth.stdout, /patched=1/, fifth.stdout)
  } finally { rmSync(repoShape, { recursive: true, force: true }) }

  const patchedSource = readFileSync(file, 'utf8')
  assert.match(patchedSource, /canonicalLockPath/)
  console.log('patch-session-lock.test: ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
