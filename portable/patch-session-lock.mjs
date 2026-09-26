// patch-session-lock.mjs <node_modules | @deepseek-ai dir | repo root>
//
// Why: the Windows session write lock is a named kernel semaphore whose name is hashed from the lock
// path, and the stock code hashes path.resolve(path) --- a purely lexical spelling. One file reached
// through two spellings (a linked DSH_HOME, a junction, a subst drive) therefore yields two names and
// the lock silently stops excluding the second writer. Hash the reparse-point-resolved path instead.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const PKG = 'dsh-session-persistence-jsonl'
const MARKER = 'dsh-session-lock-${'
const UNPATCHED = 'update(resolve(path).toLowerCase()).digest("hex")'
const PATCHED = 'update((await canonicalLockPath(path)).toLowerCase()).digest("hex")'
const ANCHOR = 'async function acquireLockHandleWin32(path) {'
const HELPER = [
  '/** Reparse-point-resolved lock path; the lexical spelling when the directory is not there yet. */',
  'async function canonicalLockPath(path) {',
  '\ttry { return join(await realpath(dirname(path)), basename(path)) } catch { return resolve(path) }',
  '}',
  '',
].join('\n')

/** Directories that can hold the deployed package, bounded so a repo root also works. */
function candidates(target, depth = 0) {
  const found = []
  if (!existsSync(target) || depth > 6) return found
  const direct = join(target, PKG, 'lib')
  if (existsSync(direct)) found.push(direct)
  const scoped = join(target, 'node_modules', '@deepseek-ai', PKG, 'lib')
  if (existsSync(scoped)) found.push(scoped)
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    found.push(...candidates(join(target, entry.name), depth + 1))
  }
  return found
}

function patchFile(file) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('canonicalLockPath')) return 'already'
  if (!source.includes(MARKER)) return 'absent'
  if (!source.includes(UNPATCHED)) {
    throw new Error('session lock surface changed upstream --- review ' + file)
  }
  if (!source.includes(ANCHOR)) {
    throw new Error('session lock helper anchor missing --- review ' + file)
  }
  const patched = source
    .replace(UNPATCHED, PATCHED)
    .replace(ANCHOR, HELPER + ANCHOR)
  writeFileSync(file, patched)
  return 'patched'
}

function main() {
  const target = resolve(process.argv[2] ?? '.')
  const dirs = candidates(target)
  if (dirs.length === 0) throw new Error('deployed ' + PKG + ' not found under ' + target)
  const tally = { patched: 0, already: 0, absent: 0 }
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!/\.(m?js|cjs)$/.test(name)) continue
      const file = join(dir, name)
      if (!statSync(file).isFile()) continue
      tally[patchFile(file)] += 1
    }
  }
  if (tally.patched === 0 && tally.already === 0) {
    throw new Error('no session lock surface found under ' + dirs.join(', '))
  }
  console.log('patch-session-lock: patched=' + tally.patched + ' already=' + tally.already)
}

main()
