// patch-desktop-guest-devtools 回归测试：fixture + 幂等 + 锚点缺失/重复必须报错。
// 运行: node tests/patch-desktop-guest-devtools.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { patchDesktopGuestDevtools, FILE } from '../portable/patch-desktop-guest-devtools.mjs'

const FIXTURE = [
  '      Object.assign(preferences, {',
  '        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,',
  '        devTools: !app.isPackaged,',
  '      })',
  '        lease.guest = guest',
  '        attachedLease = id',
  '        lease.releaseInput = attachInput(guest, id)',
  "        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })",
  '',
].join('\n')

function tree(text) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guest-devtools-'))
  const path = join(root, FILE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return { root, read: () => readFileSync(path, 'utf8') }
}

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('applies both edits', () => {
  const t = tree(FIXTURE)
  try {
    assert.equal(patchDesktopGuestDevtools(t.root).applied.length, 2)
    const out = t.read()
    assert.ok(!out.includes('devTools: !app.isPackaged'))
    assert.ok(out.includes('devTools: true'))
    assert.ok(out.includes("guest.on('before-input-event'"))
    assert.ok(out.includes("guest.openDevTools({ mode: 'detach' })"))
    assert.ok(out.indexOf('attachInput(guest, id)') < out.indexOf("guest.on('before-input-event'"))
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('is idempotent', () => {
  const t = tree(FIXTURE)
  try {
    patchDesktopGuestDevtools(t.root)
    const once = t.read()
    assert.equal(patchDesktopGuestDevtools(t.root).applied.length, 0)
    assert.equal(t.read(), once)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('missing anchor fails loudly', () => {
  const t = tree(FIXTURE.replace('devTools: !app.isPackaged,', 'devTools: false,'))
  try { assert.throws(() => patchDesktopGuestDevtools(t.root), /found 0/) }
  finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('duplicate anchor fails loudly', () => {
  const t = tree(FIXTURE + '        devTools: !app.isPackaged,\n')
  try { assert.throws(() => patchDesktopGuestDevtools(t.root), /found 2/) }
  finally { rmSync(t.root, { recursive: true, force: true }) }
})

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  PASS ${name}`) } catch (error) { console.log(`  FAIL ${name}\n    ${error.message}`) }
}
console.log(`\n${passed}/${tests.length} 通过`)
if (passed !== tests.length) process.exit(1)
