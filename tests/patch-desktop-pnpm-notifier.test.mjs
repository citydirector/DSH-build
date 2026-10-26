// patch-desktop-pnpm-notifier 回归测试：两处入口都打上 + 幂等 + 锚点缺失/重复必须报错。
// 运行: node tests/patch-desktop-pnpm-notifier.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { patchDesktopPnpmNotifier, FILES } from '../portable/patch-desktop-pnpm-notifier.mjs'

/** cli.ts 的 packageManager.env（6 空格缩进）。 */
const CLI_FIXTURE = [
  '  await runCli({',
  '    packageManager: {',
  '      command: process.execPath,',
  '      args: [],',
  '      env: {',
  "        ELECTRON_RUN_AS_NODE: '1',",
  '        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,',
  "        PATH: `${join(supportDir, 'bin')}`,",
  '      },',
  '    },',
  '  })',
  '',
].join('\n')

/** index.ts 的 packageManager.env（8 空格缩进，多一层对象）。 */
const INDEX_FIXTURE = [
  '  const application = runProfile({',
  '    ...(process.argv[5] === undefined ? {} : {',
  '      packageManager: {',
  '        command: process.execPath,',
  '        args: [],',
  '        env: {',
  "          ELECTRON_RUN_AS_NODE: '1',",
  '          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,',
  "          PATH: `${process.argv[6] ?? ''}`,",
  '        },',
  '      },',
  '    }),',
  '  })',
  '',
].join('\n')

function tree(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-notifier-'))
  for (const file of FILES) {
    const text = overrides[file] ?? (file === FILES[0] ? CLI_FIXTURE : INDEX_FIXTURE)
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return { root, read: (file) => readFileSync(join(root, file), 'utf8') }
}

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('两处入口都写入 PNPM_CONFIG_UPDATE_NOTIFIER', () => {
  const t = tree()
  try {
    assert.equal(patchDesktopPnpmNotifier(t.root).applied.length, 2)
    for (const file of FILES) {
      const out = t.read(file)
      assert.ok(out.includes("PNPM_CONFIG_UPDATE_NOTIFIER: 'false',"), file)
      // 必须落在 env 对象里：排在 DSH_DESKTOP_NODE_EXECUTABLE 之后、PATH 之前
      assert.ok(out.indexOf('DSH_DESKTOP_NODE_EXECUTABLE') < out.indexOf('PNPM_CONFIG_UPDATE_NOTIFIER'), file)
      assert.ok(out.indexOf('PNPM_CONFIG_UPDATE_NOTIFIER') < out.indexOf('PATH:'), file)
    }
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('缩进跟随所在块的层级', () => {
  const t = tree()
  try {
    patchDesktopPnpmNotifier(t.root)
    // cli.ts 是 6 空格 env 块 → 字段行 8 空格；index.ts 是 8 空格 env 块 → 字段行 10 空格
    assert.match(t.read(FILES[0]), /\n {8}PNPM_CONFIG_UPDATE_NOTIFIER/u)
    assert.match(t.read(FILES[1]), /\n {10}PNPM_CONFIG_UPDATE_NOTIFIER/u)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('幂等：第二次不写字节', () => {
  const t = tree()
  try {
    patchDesktopPnpmNotifier(t.root)
    const once = FILES.map((file) => t.read(file))
    assert.equal(patchDesktopPnpmNotifier(t.root).applied.length, 0)
    assert.deepEqual(FILES.map((file) => t.read(file)), once)
  } finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('锚点缺失必须大声失败', () => {
  const broken = CLI_FIXTURE.replace("        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,\n", '')
  const t = tree({ [FILES[0]]: broken })
  try { assert.throws(() => patchDesktopPnpmNotifier(t.root), /found 0/) }
  finally { rmSync(t.root, { recursive: true, force: true }) }
})

test('锚点重复必须大声失败', () => {
  const doubled = CLI_FIXTURE + "      env: {\n        ELECTRON_RUN_AS_NODE: '1',\n        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,\n"
  const t = tree({ [FILES[0]]: doubled })
  try { assert.throws(() => patchDesktopPnpmNotifier(t.root), /found 2/) }
  finally { rmSync(t.root, { recursive: true, force: true }) }
})

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  PASS ${name}`) } catch (error) { console.log(`  FAIL ${name}\n    ${error.message}`) }
}
console.log(`\n${passed}/${tests.length} 通过`)
if (passed !== tests.length) process.exit(1)
