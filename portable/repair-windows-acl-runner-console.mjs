// repair-windows-acl-runner-console.mjs <tree-root> [<tree-root> ...]
// repair-windows-acl-runner-console.mjs --asar <in.asar> <out.asar>
//
// 现场修复工具：修**已经发布出去**的安装（源码已经编译不回来）。
// ⚠️ 它**不参与** build-desktop.mjs 流水线 —— 流水线用的是源码补丁
// `portable/patch-windows-acl-runner-console.mjs`（打在 packages/sandbox/sandbox-windows-acl/src/，
// 构建时插入，产物自带修复）。本文件只用于：本机已装好的 app.asar / 解包树需要当场修好，
// 而重打包又必须先关掉桌面端（app.asar 运行时被独占锁定）。
//
// Why: AclSandbox spawns the restricted child through
//   CreateProcessAsUserW(..., creationFlags = 0, ...)
// so the child attaches to whatever console the confinement RUNNER owns. A console-subsystem
// image owns one even under CREATE_NO_WINDOW (that is the portable/node install, which
// works); the Electron image is GUI-subsystem and never owns one, so under the Desktop
// install every confined command dies inside DLL initialization with STATUS_DLL_INIT_FAILED
// (0xC0000142) and an EMPTY stderr. Nothing the seam can match reaches it, so the operator
// sees a bare "[exit code: 3221225794]" and reads it as a failing command.
//
// The fix is to give the runner a console of its own before it spawns the child, and to hide
// that console's window so nothing appears on screen. Measured on this machine under
// Electron-as-node with the chain's windowsHide (CREATE_NO_WINDOW):
//   without AllocConsole -> child exit 0xC0000142, empty stderr
//   with    AllocConsole -> child exit 0, stdout passes through, std handles unchanged
// It is a no-op wherever a console already exists, so it cannot regress a node install.
//
// Two edits, both in dsh-sandbox-windows-acl/lib/runner.js:
//   1. await ensureSharedConsole() before sandbox.spawn(...)
//   2. the helper itself, appended
//   3. a child that still dies with 0xC0000142 is reported as a runner failure (exit 127 plus
//      the `windows-acl-run:` signature) instead of a silent, unclassifiable exit code.
//
// Why NOT swap the runner's interpreter for the bundled node.exe: inside a packaged Desktop
// release the runner entry resolves to resources/app.asar/dsh/... , and a plain node.exe
// cannot read inside an asar at all. This file is also what a rebuild would carry, and it
// works in both the unpacked and the asar layout without touching any path.
//
// A Desktop release serves the package from inside resources/app.asar, which is locked while
// the app runs: use --asar while Desktop is closed to rewrite the archive.
//
// 用法:
//   node portable/repair-windows-acl-runner-console.mjs D:\dsh-portable\app
//   node portable/repair-windows-acl-runner-console.mjs --asar resources\app.asar <staging>\app.asar
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Marker proving the shared-console helper was injected. */
const CONSOLE_MARKER = 'ensureSharedConsole'
/** Marker proving the runner got the 0xC0000142 diagnostic. */
const DLL_INIT_MARKER = 'STATUS_DLL_INIT_FAILED'
/** Depth bound of the tree walk; deep enough for a repo root, shallow enough to stay cheap. */
const MAX_DEPTH = 8

/** Set to 0 to leave the runner exactly as shipped. */
const CONSOLE_ENV = 'DSH_ACL_SHARED_CONSOLE'

/**
 * Appended to the runner. `fail` and `RunnerFailure` already exist in this file, and `koffi`
 * is one of the package's own dependencies, so nothing new has to be resolved.
 */
const CONSOLE_HELPER = `
//#region DSH-build: give this runner the console the restricted child has to share
/**
 * koffi hands back null for a NULL pointer but a number or an external for a live one, so a
 * truthiness test is the only safe form.
 * @param value - a pointer value as koffi returned it.
 * @returns whether it denotes NULL.
 */
function isNullPointer(value) {
\tif (value === null || value === undefined) return true;
\ttry {
\t\treturn Number(value) === 0;
\t} catch {
\t\treturn false;
\t}
}
/**
 * The ACL sandbox spawns the restricted child with creationFlags 0, so the child attaches to
 * whatever console THIS runner owns. A console-subsystem image owns one even when it was
 * created with CREATE_NO_WINDOW; the Electron image is GUI-subsystem, so under the Desktop
 * install it owns none and the child dies inside DLL initialization. Allocate one when we
 * have none, then hide its window. No console is allocated when one already exists, so a
 * node-hosted runner is untouched.
 * @returns nothing; throws RunnerFailure when a console is required and cannot be created.
 */
async function ensureSharedConsole() {
\tif (process.platform !== "win32") return;
\tif (process.env.${CONSOLE_ENV} === "0") return;
\tlet koffi;
\ttry {
\t\tkoffi = (await import("koffi")).default;
\t} catch (error) {
\t\t// The runner's own dependency graph already loads koffi, so a miss here means the
\t\t// installation is broken; say so instead of surfacing a bare module-resolution stack.
\t\tfail(\`koffi is unavailable, so the runner cannot create the console the confined child needs: \${error instanceof Error ? error.message : String(error)}\`);
\t}
\tconst bind = (library, name, result, args) => library.func("__stdcall", name, result, args);
\tconst kernel32 = koffi.load("kernel32.dll");
\tconst getConsoleWindow = bind(kernel32, "GetConsoleWindow", "void *", []);
\tif (!isNullPointer(getConsoleWindow())) return;
\tconst allocConsole = bind(kernel32, "AllocConsole", "bool", []);
\tif (!allocConsole()) {
\t\tconst getLastError = bind(kernel32, "GetLastError", "uint32", []);
\t\tfail(\`AllocConsole failed (Win32 \${String(getLastError())}): the confined child has no console to share\`);
\t}
\tconst window = getConsoleWindow();
\tif (isNullPointer(window)) fail("AllocConsole reported success but GetConsoleWindow is still NULL");
\tbind(koffi.load("user32.dll"), "ShowWindow", "bool", ["void *", "int"])(window, 0);
}
//#endregion
`

/** Shared anchor for the call site in front of the restricted spawn. */
const SPAWN_ANCHOR = /([ \t]*)const child = sandbox\.spawn\(\{/u
/** Shared anchor for the child exit-code passthrough. */
const CHILD_EXIT_PATTERN = /([ \t]*)return \(await child\.wait\(\)\)\.exitCode;/u

/**
 * One edit whose target must occur exactly once, so an upstream rewrite fails loudly instead
 * of silently patching nothing. Anchors match by `pattern` and keep the captured indentation,
 * so a reformat that only moves whitespace is not a false drift.
 * @typedef {{ name: string, from?: string, pattern?: RegExp, to: string }} Edit
 */

/**
 * The per-package edit set.
 * @type {ReadonlyArray<{ package: string, file: RegExp, marker: string, edits: ReadonlyArray<Edit>, tail: string }>}
 */
const TARGETS = [
  {
    package: 'dsh-sandbox-windows-acl',
    file: /^runner\.js$/u,
    marker: CONSOLE_MARKER,
    edits: [
      {
        name: 'shared console before the restricted spawn',
        pattern: SPAWN_ANCHOR,
        to: '$1// DSH-build: the restricted child attaches to the console this runner owns.\n$1await ensureSharedConsole();\n$1const child = sandbox.spawn({',
      },
      {
        name: 'child exit code passthrough',
        pattern: CHILD_EXIT_PATTERN,
        to: '$1const exitCode = (await child.wait()).exitCode;\n'
          + '$1// A runner with no console cannot share one with the restricted child, so the child\n'
          + '$1// dies before its entry point. Reporting the raw code leaves the seam nothing to\n'
          + '$1// match and the tool shows a bare exit status; the signature classifies it.\n'
          + '$1if (exitCode === STATUS_DLL_INIT_FAILED || exitCode === (STATUS_DLL_INIT_FAILED | 0)) {\n'
          + '$1\tfail("the confined child died during DLL initialization (0xC0000142 STATUS_DLL_INIT_FAILED): the runner has no console to share with it (DSH-build portable/repair-windows-acl-runner-console.mjs).");\n'
          + '$1}\n'
          + '$1return exitCode;',
      },
    ],
    tail: CONSOLE_HELPER + `
//#region DSH-build: name the console-less failure
/** STATUS_DLL_INIT_FAILED: the restricted child never reached its entry point. */
const STATUS_DLL_INIT_FAILED = 0xC0000142;
//#endregion
`,
  },
]

/** 4-byte ceiling: the alignment every asar pickle uses for its payload. */
function align4(value) {
  return Math.ceil(value / 4) * 4
}

/** How many times an anchor occurs. `split` cannot count a pattern with capture groups---
 * it splices the captures into its own result---so regex anchors are counted with matchAll. */
function countMatches(text, anchor) {
  if (typeof anchor === 'string') return text.split(anchor).length - 1
  const flags = anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g'
  const matches = text.match(new RegExp(anchor.source, flags))
  return matches === null ? 0 : matches.length
}

/**
 * Apply one target's edits to one file's source text.
 * @param source - current file text.
 * @param target - target descriptor owning the edits.
 * @param label - location for error messages.
 * @returns the patched text.
 */
function patchSource(source, target, label) {
  if (source.includes(target.marker)) return source
  let patched = source
  for (const edit of [...(target.imports ?? []), ...target.edits]) {
    const anchor = edit.pattern ?? edit.from
    const occurrences = countMatches(patched, anchor)
    if (occurrences !== 1) {
      throw new Error(`${label}: ${edit.name}: expected exactly 1 occurrence, found ${occurrences} --- the surface changed upstream`)
    }
    patched = patched.replace(anchor, edit.to)
  }
  patched += target.tail
  if (!patched.includes(target.marker)) throw new Error(`${label}: patch did not take`)
  return patched
}

/**
 * Collect the deployed lib directories of every patched package under one root.
 * Follows junctions and symlinks (pnpm links packages across trees) and de-duplicates by
 * real path, so a store copy reachable through two spellings is patched exactly once.
 * Package directories outside node_modules are still reached; package directories inside
 * node_modules are pruned, which keeps the walk cheap without hiding a nested target.
 * @param root - installation, repo, or node_modules root.
 * @returns lib directories, in discovery order.
 */
function findLibDirectories(root) {
  const names = TARGETS.map((target) => target.package)
  const found = []
  const seen = new Set()
  const visited = new Set()
  /**
   * The target owning a directory: by directory name first, then by declared manifest name,
   * because a workspace package directory does not have to be named after its package.
   * @param directory - candidate package directory.
   * @returns the matching target, or undefined.
   */
  const targetAt = (directory) => {
    const byName = TARGETS.find((target) => target.package === basename(directory))
    if (byName !== undefined) return byName
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    } catch {
      return undefined
    }
    if (typeof manifest.name !== 'string') return undefined
    // The manifest name carries its scope ("@deepseek-ai/..."); the target key does not.
    const unscoped = manifest.name.slice(manifest.name.lastIndexOf('/') + 1)
    return TARGETS.find((target) => target.package === unscoped)
  }
  const visit = (directory, depth, inNodeModules) => {
    if (depth > MAX_DEPTH) return
    let real
    try {
      real = realpathSync(directory)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    if (inNodeModules && !names.includes(basename(directory)) && existsSync(join(directory, 'package.json'))) return
    for (const entry of entries) {
      if (entry.name === '.pnpm') continue
      const path = join(directory, entry.name)
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(path).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!isDirectory) continue
      const lib = join(path, 'lib')
      const target = existsSync(lib) ? targetAt(path) : undefined
      if (target !== undefined) {
        let libReal
        try {
          libReal = realpathSync(lib)
        } catch {
          continue
        }
        if (!seen.has(libReal)) {
          seen.add(libReal)
          found.push({ lib, target })
        }
        continue
      }
      visit(path, depth + 1, inNodeModules || entry.name === 'node_modules')
    }
  }
  visit(resolve(root), 0, false)
  return found
}

/**
 * Patch every patched-package lib file under one tree root.
 * @param root - installation or repo root.
 * @returns per-package tallies plus the files written.
 */
function patchTree(root) {
  const libs = findLibDirectories(root)
  if (libs.length === 0) {
    throw new Error(`no deployed ${TARGETS.map((target) => target.package).join(', ')} found under ${resolve(root)}`)
  }
  const tally = { patched: 0, already: 0 }
  const touched = []
  for (const { lib, target } of libs) {
    const names = readdirSync(lib).filter((name) => target.file.test(name))
    if (names.length === 0) throw new Error(`${lib}: no ${String(target.file)} found --- the built surface changed upstream`)
    for (const name of names) {
      const file = join(lib, name)
      if (!statSync(file).isFile()) continue
      const source = readFileSync(file, 'utf8')
      if (source.includes(target.marker)) {
        tally.already += 1
        continue
      }
      writeFileSync(file, patchSource(source, target, file))
      tally.patched += 1
      touched.push(file)
    }
  }
  if (tally.patched === 0 && tally.already === 0) throw new Error(`no runner surface found under ${libs.map((entry) => entry.lib).join(', ')}`)
  return { tally, touched }
}

//#region asar container
/**
 * Read an asar header and its data-region base.
 * @param path - archive path.
 * @returns file descriptor, parsed header, and data offset.
 */
function readAsarHeader(path) {
  const fd = openSync(path, 'r')
  try {
    const sizePickle = Buffer.alloc(8)
    if (readSync(fd, sizePickle, 0, 8, 0) !== 8) throw new Error(`${path}: truncated size pickle`)
    if (sizePickle.readUInt32LE(0) !== 4) throw new Error(`${path}: unexpected size-pickle payload`)
    const headerSize = sizePickle.readUInt32LE(4)
    const headerPickle = Buffer.alloc(headerSize)
    if (readSync(fd, headerPickle, 0, headerSize, 8) !== headerSize) throw new Error(`${path}: truncated header`)
    const jsonSize = headerPickle.readUInt32LE(4)
    const header = JSON.parse(headerPickle.toString('utf8', 8, 8 + jsonSize))
    if (header.files === undefined) throw new Error(`${path}: header has no files map`)
    if (headerSize !== align4(jsonSize) + 8) throw new Error(`${path}: header pickle and json length disagree`)
    return { fd, header, dataOffset: 8 + headerSize }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/**
 * Walk every file entry of an asar header in header order.
 * @param header - parsed asar header.
 * @returns entries with their archive-relative path and owning object.
 */
function asarEntries(header) {
  const entries = []
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) visit(entry, path)
      else entries.push({ path, entry })
    }
  }
  visit(header, '')
  return entries
}

/**
 * Serialize an asar header into its size pickle plus header pickle.
 * @param header - header object.
 * @returns the two buffers written before the data region, plus the new data base.
 */
function packAsarHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const headerSize = align4(json.length) + 8
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerSize, 4)
  const headerPickle = Buffer.alloc(headerSize)
  headerPickle.writeUInt32LE(headerSize - 4, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  return { sizePickle, headerPickle, dataOffset: 8 + headerSize }
}

/** Copy one byte range between descriptors without materializing it twice. */
function copyRange(from, to, length, fromPosition, toPosition) {
  const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(length, 1)))
  let copied = 0
  while (copied < length) {
    const wanted = Math.min(chunk.length, length - copied)
    const read = readSync(from, chunk, 0, wanted, fromPosition + copied)
    if (read <= 0) throw new Error('asar: unexpected end of source archive')
    let written = 0
    while (written < read) written += writeSync(to, chunk, written, read - written, toPosition + copied + written)
    copied += read
  }
}

/**
 * The patched members of one archive, keyed by archive-relative path.
 * @param input - source archive path.
 * @param source - open header handle for that archive.
 * @returns archive-relative path to replacement buffer.
 */
function asarReplacements(input, source) {
  const entries = asarEntries(source.header)
  const replacements = new Map()
  for (const target of TARGETS) {
    const members = entries.filter(({ path }) =>
      path.includes(`/@deepseek-ai/${target.package}/lib/`) && target.file.test(basename(path)))
    if (members.length === 0) {
      throw new Error(`asar: no ${target.package}/lib members found --- the runtime tree changed upstream`)
    }
    for (const { path, entry } of members) {
      if (entry.unpacked === true) throw new Error(`asar: ${path} is unpacked; patch the real file under ${input}.unpacked instead`)
      const length = Number(entry.size)
      const buffer = Buffer.alloc(length)
      if (readSync(source.fd, buffer, 0, length, source.dataOffset + Number(entry.offset)) !== length) {
        throw new Error(`asar: short read for ${path}`)
      }
      const before = buffer.toString('utf8')
      if (before.includes(target.marker)) continue
      replacements.set(path, Buffer.from(patchSource(before, target, path), 'utf8'))
    }
  }
  return replacements
}

/**
 * Rewrite one archive with the runner edit applied.
 * @param input - source archive path.
 * @param output - destination archive path.
 * @returns the patched archive-relative paths.
 */
function patchAsar(input, output) {
  const source = readAsarHeader(input)
  try {
    const replacements = asarReplacements(input, source)
    // Data blocks are captured BEFORE offsets are re-laid: an entry's offset field is
    // overwritten in place, so reading it afterwards would read the wrong bytes.
    const blocks = []
    let offset = 0
    for (const { path, entry } of asarEntries(source.header)) {
      if (entry.files !== undefined || entry.unpacked === true) continue
      const replacement = replacements.get(path)
      const size = replacement === undefined ? Number(entry.size) : replacement.length
      blocks.push({ path, entry, sourceOffset: Number(entry.offset), size, replacement })
      entry.size = size
      entry.offset = String(offset)
      offset += size
    }
    const { sizePickle, headerPickle, dataOffset } = packAsarHeader(source.header)
    const out = openSync(output, 'w')
    try {
      // Every write is positional: a positional write does not move the descriptor's own
      // cursor, so mixing the two forms silently lands later blocks at the wrong offset.
      writeSync(out, sizePickle, 0, sizePickle.length, 0)
      writeSync(out, headerPickle, 0, headerPickle.length, sizePickle.length)
      let cursor = dataOffset
      for (const block of blocks) {
        if (block.replacement !== undefined) {
          let written = 0
          while (written < block.replacement.length) {
            written += writeSync(out, block.replacement, written, block.replacement.length - written, cursor + written)
          }
        } else {
          copyRange(source.fd, out, block.size, source.dataOffset + block.sourceOffset, cursor)
        }
        cursor += block.size
      }
      if (cursor !== dataOffset + offset) throw new Error('asar: data region bookkeeping disagrees')
    } finally {
      closeSync(out)
    }
    verifyAsar(input, output, replacements)
    return [...replacements.keys()]
  } finally {
    closeSync(source.fd)
  }
}

/**
 * Re-read the rewritten archive and prove it carries every source entry byte for byte,
 * except the patched members, which must carry exactly the replacement bytes.
 * @param input - source archive path.
 * @param output - rewritten archive path.
 * @param replacements - archive-relative path to replacement buffer.
 */
function verifyAsar(input, output, replacements) {
  const source = readAsarHeader(input)
  const written = readAsarHeader(output)
  try {
    const original = new Map(asarEntries(source.header).map(({ path, entry }) => [path, entry]))
    const entries = asarEntries(written.header)
    if (entries.length !== original.size) throw new Error('asar: entry count changed')
    let dataBytes = 0
    for (const { path, entry } of entries) {
      const before = original.get(path)
      if (before === undefined) throw new Error(`asar: unexpected entry ${path}`)
      if ((before.unpacked === true) !== (entry.unpacked === true)) throw new Error(`asar: ${path} changed its unpacked flag`)
      if (entry.unpacked === true) {
        // The bytes live outside the archive; only the record is ours to preserve.
        if (Number(entry.size) !== Number(before.size)) throw new Error(`asar: ${path} changed size`)
        if (JSON.stringify(entry.integrity) !== JSON.stringify(before.integrity)) throw new Error(`asar: ${path} changed integrity`)
        continue
      }
      const replacement = replacements.get(path)
      const length = replacement === undefined ? Number(entry.size) : replacement.length
      dataBytes += length
      const actual = Buffer.alloc(length)
      if (readSync(written.fd, actual, 0, length, written.dataOffset + Number(entry.offset)) !== length) {
        throw new Error(`asar: short read back for ${path}`)
      }
      if (replacement !== undefined) {
        if (!actual.equals(replacement)) throw new Error(`asar: ${path} does not carry the patched bytes`)
        continue
      }
      const expected = Buffer.alloc(Number(before.size))
      if (readSync(source.fd, expected, 0, expected.length, source.dataOffset + Number(before.offset)) !== expected.length) {
        throw new Error(`asar: short read for source ${path}`)
      }
      if (!actual.equals(expected)) throw new Error(`asar: ${path} changed bytes`)
    }
    if (written.dataOffset + dataBytes !== statSync(output).size) throw new Error('asar: rewritten archive does not end at EOF')
  } finally {
    closeSync(source.fd)
    closeSync(written.fd)
  }
}
//#endregion

/**
 * CLI entry: tree mode patches deployed files in place, asar mode rewrites an archive.
 */
function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--asar') {
    if (argv.length !== 3 || argv[1] === undefined || argv[2] === undefined) {
      console.error('用法: node portable/repair-windows-acl-runner-console.mjs --asar <in.asar> <out.asar>')
      process.exit(2)
    }
    const patched = patchAsar(resolve(argv[1]), resolve(argv[2]))
    console.log(`repair-windows-acl-runner-console: asar patched=${String(patched.length)} verified`)
    for (const path of patched) console.log(`  + ${path}`)
    return
  }
  if (argv.length === 0) {
    console.error('用法: node portable/repair-windows-acl-runner-console.mjs <tree-root> [<tree-root> ...]')
    process.exit(2)
  }
  let patched = 0
  let already = 0
  for (const root of argv) {
    const result = patchTree(root)
    patched += result.tally.patched
    already += result.tally.already
    for (const file of result.touched) console.log(`  + ${file}`)
  }
  console.log(`repair-windows-acl-runner-console: patched=${String(patched)} already=${String(already)}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
