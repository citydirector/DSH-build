// portable/cua-helper.mjs 的单元测试（node:test，零依赖）。
// 运行: node tests/cua-helper.test.mjs
//
// 这里测的是**契约**，不是 .NET 编译：真实的 win-x64 publish 只在装有 .NET 10 SDK 的
// Windows CI 上跑（ci/portable/build-cua-helper.ps1），本机没有 SDK 也不该装。
// 所以 fake payload 用假 exe/dll —— 只要整树摘要与清单自洽，校验逻辑就是同一套。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  HELPER_EXECUTABLE,
  MANIFEST_NAME,
  REQUIRED_RUNTIME_FILES,
  extractTarGz,
  installedExecutablePath,
  installPayload,
  main,
  readManifest,
  readNativeSource,
  resolveSafeOutput,
  sourceHelperDirectory,
  stagePayload,
  upstreamVersion,
  validateNativeSource,
  verifyInstalled,
  verifyPayload,
  writeManifest,
} from '../portable/cua-helper.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP_ROOT = join(ROOT, '_skadi_temp')
const COMMIT = '39163dd30f703a79079e2d2446545cff3c453738'
const OTHER_COMMIT = '0'.repeat(40)
const SDK = '10.0.100'

function workspace() {
  mkdirSync(TEMP_ROOT, { recursive: true })
  return mkdtempSync(join(TEMP_ROOT, 'cua-helper-'))
}

/** patch-cua-ui-locate-bridge.mjs --digest 的输出形状（真实值由该脚本给出，这里只要自洽）。 */
const NATIVE_SOURCE = {
  algorithm: 'sha256-tree-v1',
  digest: `sha256:${'a'.repeat(64)}`,
  upstreamCommit: COMMIT,
  fileCount: 2,
  files: {
    'entry/Input.cs': `sha256:${'b'.repeat(64)}`,
    'entry/Win32.cs': `sha256:${'c'.repeat(64)}`,
  },
}

/** 造一份形状合法的 self-contained payload，并写下它的清单。 */
function makePayload(directory, { exe = 'MZ-fake-helper', architecture = 'x64', nativeSource = NATIVE_SOURCE } = {}) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, HELPER_EXECUTABLE), exe)
  for (const rel of REQUIRED_RUNTIME_FILES) {
    if (rel === HELPER_EXECUTABLE) continue
    writeFileSync(join(directory, rel), `fake ${rel}`)
  }
  writeFileSync(join(directory, 'CuaProtocol.dll'), 'fake protocol dll')
  writeFileSync(join(directory, 'System.Private.CoreLib.dll'), 'fake corelib')
  return writeManifest(directory, { commit: COMMIT, version: '0.2.2-rc.3', sdk: SDK, architecture, signing: 'unsigned', nativeSource })
}

/** 进程内造一个 npm pack 同形的 .tgz（不 spawn 系统 tar：受限环境会 EPERM）。 */
function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\u0000' + '00', 257, 8, 'ascii')
  header.fill(' ', 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function makeTarGz(entries) {
  const parts = []
  for (const [name, content] of entries) {
    const data = Buffer.from(content)
    parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

test('writeManifest：整树登记、buildKey 由 commit+sdk+架构决定、清单自身不入 files', () => {
  const dir = workspace()
  try {
    const manifest = makePayload(dir)
    const expectedKey = createHash('sha256').update(`${COMMIT}\n${SDK}\nx64`, 'utf8').digest('hex')
    assert.equal(manifest.buildKey, expectedKey)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.platform, 'windows')
    assert.equal(manifest.architecture, 'x64')
    assert.equal(manifest.executable, HELPER_EXECUTABLE)
    assert.equal(manifest.sha256, manifest.files[HELPER_EXECUTABLE])
    assert.equal(manifest.files[MANIFEST_NAME], undefined)
    for (const rel of REQUIRED_RUNTIME_FILES) assert.ok(manifest.files[rel], `清单缺 ${rel}`)
    // 落盘的清单能被读回，且形状一致
    assert.deepEqual(readManifest(dir), manifest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：正常通过，并回报文件数', () => {
  const dir = workspace()
  try {
    const written = makePayload(dir)
    const verified = verifyPayload(dir, { commit: COMMIT, architecture: 'x64' })
    assert.equal(Object.keys(verified.files).length, Object.keys(written.files).length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：payload 被改一个字节就失败（摘要不符）', () => {
  const dir = workspace()
  try {
    makePayload(dir)
    writeFileSync(join(dir, HELPER_EXECUTABLE), 'MZ-fake-helper-tampered')
    assert.throws(() => verifyPayload(dir), /摘要不符/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：清单登记了但文件被删掉 → 失败', () => {
  const dir = workspace()
  try {
    makePayload(dir)
    rmSync(join(dir, 'CuaProtocol.dll'))
    assert.throws(() => verifyPayload(dir), /清单登记了 CuaProtocol\.dll/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：目录里多出未登记的文件 → 失败（清单必须覆盖整树）', () => {
  const dir = workspace()
  try {
    makePayload(dir)
    writeFileSync(join(dir, 'sneaked-in.dll'), 'not in manifest')
    assert.throws(() => verifyPayload(dir), /未登记的文件：sneaked-in\.dll/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：缺 self-contained 运行时文件 → 失败（exe 在也起不来）', () => {
  const dir = workspace()
  try {
    const manifest = makePayload(dir)
    // 删掉 deps.json 重新生成清单：这样「清单覆盖整树」通过，但必需文件缺失。
    rmSync(join(dir, 'dsh-cua-windows.deps.json'))
    assert.ok(manifest.files['dsh-cua-windows.deps.json'])
    writeManifest(dir, { commit: COMMIT, version: '0.2.2-rc.3', sdk: SDK, architecture: 'x64', nativeSource: NATIVE_SOURCE })
    assert.throws(() => verifyPayload(dir), /缺少 self-contained 运行时文件 dsh-cua-windows\.deps\.json/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：别的上游提交 / 别的架构都拒绝', () => {
  const dir = workspace()
  try {
    makePayload(dir)
    assert.throws(() => verifyPayload(dir, { commit: OTHER_COMMIT }), /不允许混入别的提交的 helper/u)
    assert.throws(() => verifyPayload(dir, { architecture: 'arm64' }), /架构是 x64，本次需要 arm64/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：清单字段被改（sha256 与 files 不一致）→ 失败', () => {
  const dir = workspace()
  try {
    const manifest = makePayload(dir)
    const tampered = { ...manifest, sha256: 'f'.repeat(64) }
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(tampered))
    assert.throws(() => verifyPayload(dir), /sha256 与 files 里 exe 的摘要不一致/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installPayload：装到 packageRoot/native/bin/win-x64，二次调用不再写盘', () => {
  const dir = workspace()
  try {
    const source = join(dir, 'payload')
    makePayload(source)
    const packageRoot = join(dir, 'node_modules', '@deepseek-ai', 'dsh-cua-windows')
    mkdirSync(packageRoot, { recursive: true })

    const first = installPayload(source, packageRoot, { commit: COMMIT })
    assert.equal(first.changed, true)
    const installed = join(packageRoot, 'native', 'bin', 'win-x64')
    assert.ok(existsSync(join(installed, HELPER_EXECUTABLE)))
    assert.deepEqual(readManifest(installed), readManifest(source))

    const second = installPayload(source, packageRoot, { commit: COMMIT })
    assert.equal(second.changed, false, '相同 payload 二次安装必须是无写盘的')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installPayload：目标被篡改时会覆盖，而不是留着一份坏 helper', () => {
  const dir = workspace()
  try {
    const source = join(dir, 'payload')
    makePayload(source)
    const packageRoot = join(dir, 'pkg')
    installPayload(source, packageRoot)
    writeFileSync(join(packageRoot, 'native', 'bin', 'win-x64', HELPER_EXECUTABLE), 'broken')
    const result = installPayload(source, packageRoot, { commit: COMMIT })
    assert.equal(result.changed, true)
    verifyInstalled(packageRoot, { commit: COMMIT, architecture: 'x64' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stagePayload：只写到上游树的 packages/experimental/cua-windows/native/bin/win-x64', () => {
  const dir = workspace()
  try {
    const source = join(dir, 'artifact')
    makePayload(source)
    const upstream = join(dir, 'upstream')
    mkdirSync(upstream, { recursive: true })
    stagePayload(source, upstream, { commit: COMMIT })
    const expected = sourceHelperDirectory(upstream, 'x64')
    assert.equal(
      expected,
      join(upstream, 'packages', 'experimental', 'cua-windows', 'native', 'bin', 'win-x64'),
    )
    verifyPayload(expected, { commit: COMMIT, architecture: 'x64' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI --native-digest：单独给摘要也必须真的比较（旧二进制不能被放过）', () => {
  const dir = workspace()
  try {
    const root = join(dir, 'upstream')
    const source = join(dir, 'payload')
    makePayload(source)
    stagePayload(source, root, { commit: COMMIT, architecture: 'x64' })
    // 匹配：回到 0
    assert.equal(main(['verify', '--root', root, '--commit', COMMIT, '--native-digest', NATIVE_SOURCE.digest]), 0)
    // 不匹配：必须抛，而不是静默放过
    assert.throws(
      () => main(['verify', '--root', root, '--commit', COMMIT, '--native-digest', `sha256:${'d'.repeat(64)}`]),
      /期望 sha256:d{64}/u,
    )
    // 形状不对：直接拒绝
    assert.throws(
      () => main(['verify', '--root', root, '--commit', COMMIT, '--native-digest', 'nope']),
      /必须是 sha256:/u,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安装态路径按上游语义把 app.asar 换成 app.asar.unpacked', () => {
  const unpacked = installedExecutablePath('C:/stage/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-cua-windows')
  assert.equal(
    unpacked,
    join('C:/stage/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-cua-windows', 'native', 'bin', 'win-x64', HELPER_EXECUTABLE),
  )
  const inAsar = installedExecutablePath('C:/stage/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-cua-windows')
  assert.match(inAsar.replaceAll('\\', '/'), /app\.asar\.unpacked\/dsh\/node_modules\/@deepseek-ai\/dsh-cua-windows\/native\/bin\/win-x64\/dsh-cua-windows\.exe$/u)
})

test('verifyInstalled：缺 exe 时给出 ENOENT 语义的失败（上游 prepareNativeExecutable 也会拒绝）', () => {
  const dir = workspace()
  try {
    const packageRoot = join(dir, 'pkg')
    mkdirSync(packageRoot, { recursive: true })
    assert.throws(() => verifyInstalled(packageRoot), /安装态缺 .*dsh-cua-windows\.exe/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读上游版本号；缺 version 时失败', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.2-rc.3' }))
    assert.equal(upstreamVersion(dir), '0.2.2-rc.3')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
    assert.throws(() => upstreamVersion(dir), /没有 version/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nativeSource：形状校验拒绝缺字段、项数不符与非法摘要', () => {
  assert.equal(validateNativeSource(NATIVE_SOURCE).digest, NATIVE_SOURCE.digest)
  assert.throws(() => validateNativeSource({ ...NATIVE_SOURCE, algorithm: 'sha256-files-v1' }), /algorithm 应为 sha256-tree-v1/u)
  assert.throws(() => validateNativeSource({ ...NATIVE_SOURCE, digest: 'sha256:short' }), /digest 不是 sha256/u)
  assert.throws(() => validateNativeSource({ ...NATIVE_SOURCE, upstreamCommit: 'main' }), /upstreamCommit 不是 40 位/u)
  assert.throws(() => validateNativeSource({ ...NATIVE_SOURCE, fileCount: 9 }), /与 fileCount 9 不一致/u)
  assert.throws(() => validateNativeSource({ ...NATIVE_SOURCE, files: { 'entry/Input.cs': 'not-a-digest' } }), /files\.entry\/Input\.cs 不是 sha256/u)
  assert.throws(() => validateNativeSource(null), /必须是对象/u)
})

test('writeManifest：摘要的 upstreamCommit 必须与本次提交一致（否则宁可失败）', () => {
  const dir = workspace()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, HELPER_EXECUTABLE), 'MZ-fake-helper')
    assert.throws(
      () => writeManifest(dir, { commit: OTHER_COMMIT, version: '0.2.2-rc.3', sdk: SDK, nativeSource: NATIVE_SOURCE }),
      /upstreamCommit 是 .*，与本次 0{40} 不一致/u,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPayload：nativeSourceDigest 与当前源码树不符 → 失败（JS 新参数 + 旧二进制）', () => {
  const dir = workspace()
  try {
    makePayload(dir)
    assert.doesNotThrow(() => verifyPayload(dir, { nativeSourceDigest: NATIVE_SOURCE.digest }))
    assert.throws(
      () => verifyPayload(dir, { nativeSourceDigest: `sha256:${'d'.repeat(64)}` }),
      /helper 不是用这套 native 源码构建的/u,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readNativeSource：读 --digest 落的 JSON 文件；坏 JSON 明确失败', () => {
  const dir = workspace()
  try {
    const file = join(dir, 'native-source.json')
    writeFileSync(file, JSON.stringify(NATIVE_SOURCE))
    assert.equal(readNativeSource(file, COMMIT).fileCount, 2)
    writeFileSync(file, '{ not json')
    assert.throws(() => readNativeSource(file, COMMIT), /读不出原生源码摘要/u)
    assert.throws(() => readNativeSource(join(dir, 'missing.json'), COMMIT), /读不出原生源码摘要/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readNativeSource：接受补丁脚本 --digest 的原始输出（补 algorithm/upstreamCommit）', () => {
  const dir = workspace()
  try {
    const file = join(dir, 'raw.json')
    writeFileSync(file, JSON.stringify({
      kind: 'cua-helper-native-source',
      digest: NATIVE_SOURCE.digest,
      fileCount: 2,
      files: NATIVE_SOURCE.files,
    }))
    const normalized = readNativeSource(file, COMMIT)
    assert.equal(normalized.algorithm, 'sha256-tree-v1')
    assert.equal(normalized.upstreamCommit, COMMIT)
    assert.equal(normalized.digest, NATIVE_SOURCE.digest)
    // 原始输出不含提交号，调用方必须给
    assert.throws(() => readNativeSource(file), /需要 --commit/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractTarGz：只写普通文件与目录，拒绝 .. 穿越与符号链接', () => {
  const dir = workspace()
  try {
    const okTarball = join(dir, 'ok.tgz')
    writeFileSync(okTarball, makeTarGz([['package/package.json', '{"name":"x"}'], ['package/native/bin/win-x64/a.dll', 'dll']]))
    const target = join(dir, 'extract')
    assert.equal(extractTarGz(okTarball, target), 2)
    assert.equal(readFileSync(join(target, 'package', 'native', 'bin', 'win-x64', 'a.dll'), 'utf8'), 'dll')

    const evil = join(dir, 'evil.tgz')
    writeFileSync(evil, makeTarGz([['package/../../escape.txt', 'nope']]))
    assert.throws(() => extractTarGz(evil, join(dir, 'extract-evil')), /越界路径/u)
    assert.equal(existsSync(join(dir, 'escape.txt')), false)

    const link = join(dir, 'link.tgz')
    const header = tarHeader('package/link', 0, '2')
    writeFileSync(link, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))
    assert.throws(() => extractTarGz(link, join(dir, 'extract-link')), /不支持的条目类型 2/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI verify-tarball：进程内解包后按 package/native/bin/win-x64 校验，错提交则失败', () => {
  const dir = workspace()
  try {
    // 造一个与 npm pack 同形的 tarball：package/ 下是 cua-windows 的包内容。
    const packageRoot = join(dir, 'package')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-cua-windows', version: '0.2.2-rc.3' }))
    makePayload(join(packageRoot, 'native', 'bin', 'win-x64'))
    const tarball = join(dir, 'deepseek-ai-dsh-cua-windows-0.2.2-rc.3.tgz')
    writeFileSync(tarball, makeTarGz([
      ['package/package.json', readFileSync(join(packageRoot, 'package.json'))],
      ['package/native/bin/win-x64/cua-helper.json', readFileSync(join(packageRoot, 'native', 'bin', 'win-x64', MANIFEST_NAME))],
      ['package/native/bin/win-x64/dsh-cua-windows.exe', 'MZ-fake-helper'],
      ...REQUIRED_RUNTIME_FILES.filter((rel) => rel !== HELPER_EXECUTABLE)
        .map((rel) => [`package/native/bin/win-x64/${rel}`, `fake ${rel}`]),
      ['package/native/bin/win-x64/CuaProtocol.dll', 'fake protocol dll'],
      ['package/native/bin/win-x64/System.Private.CoreLib.dll', 'fake corelib'],
    ]))

    assert.equal(main(['verify-tarball', '--tarball', tarball, '--commit', COMMIT]), 0)
    // 临时解包目录必须被清掉
    assert.equal(existsSync(join(dir, '_cua-helper-extract')), false)
    assert.throws(() => main(['verify-tarball', '--tarball', tarball, '--commit', OTHER_COMMIT]), /不允许混入别的提交的 helper/u)
    const matching = join(dir, 'native-source.json')
    writeFileSync(matching, JSON.stringify(NATIVE_SOURCE))
    assert.equal(main(['verify-tarball', '--tarball', tarball, '--commit', COMMIT, '--native-source-file', matching]), 0)
    const other = join(dir, 'other-native.json')
    writeFileSync(other, JSON.stringify({ ...NATIVE_SOURCE, digest: `sha256:${'e'.repeat(64)}` }))
    assert.throws(
      () => main(['verify-tarball', '--tarball', tarball, '--commit', COMMIT, '--native-source-file', other]),
      /helper 不是用这套 native 源码构建的/u,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSafeOutput：拒绝上游本身、上游祖先、原生源码树与其祖先（publish 会先清空 out）', () => {
  const root = join(ROOT, '_skadi_temp', 'fake-upstream')
  assert.throws(() => resolveSafeOutput(root, root), /上游根目录本身/u)
  assert.throws(() => resolveSafeOutput(join(root, '..'), root), /祖先/u)
  assert.throws(() => resolveSafeOutput(join(root, 'packages', 'experimental', 'cua-windows', 'native', 'bin', 'win-x64'), root), /原生源码树/u)
  assert.throws(() => resolveSafeOutput(join(root, 'packages'), root), /包含原生源码树/u)
  // 正常输出目录仍然放行（不能把防护写成「谁都过不了」）
  assert.equal(resolveSafeOutput(join(root, 'dist', 'cua-helper-win-x64'), root).output, join(root, 'dist', 'cua-helper-win-x64'))
})

test('verifyPayload：清单里 nativeSource.upstreamCommit 与 commit 不一致 → 拒绝（读入别人产物时也要查）', () => {
  const dir = workspace()
  makePayload(dir)
  const file = join(dir, MANIFEST_NAME)
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.nativeSource = { ...manifest.nativeSource, upstreamCommit: OTHER_COMMIT }
  writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => verifyPayload(dir, { commit: COMMIT }), /清单自相矛盾/u)
})

test('readManifest：signing 只接受上游 workflow 的枚举（unsigned / authenticode）', () => {
  const dir = workspace()
  makePayload(dir)
  const file = join(dir, MANIFEST_NAME)
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...manifest, signing: 'authenticode' }))
  assert.equal(readManifest(dir).signing, 'authenticode')
  writeFileSync(file, JSON.stringify({ ...manifest, signing: 'signed' }))
  assert.throws(() => readManifest(dir), /signing 取值非法/u)
})

test('installPayload：来源位于目标目录之内 → 拒绝（否则替换目标会先删掉来源）', () => {
  const pkg = join(workspace(), '@deepseek-ai', 'dsh-cua-windows')
  const inner = join(pkg, 'native', 'bin', 'win-x64', 'inner')
  makePayload(inner)
  assert.throws(() => installPayload(inner, pkg, { commit: COMMIT }), /来源位于目标目录之内/u)
})
