/**
 * The Windows per-user environment, read fresh from the registry.
 *
 * A GUI process keeps the environment block Explorer handed it at logon. `setx`
 * from another terminal writes `HKCU\Environment`, but the running shell — and
 * every process it later starts — keeps the old snapshot until the user signs
 * out. Anything the harness resolves from `process.env` therefore sees values
 * that can be days old. This module re-reads the registry key so the process
 * environment matches what the user currently has configured.
 *
 * Kept separate from `dsh-portable-bootstrap.ts` so it carries no Electron
 * import: the parsers stay a pure function of the `reg query` text and can be
 * tested without a desktop runtime.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** One `HKCU\Environment` value; `values` holds the split entries of a REG_MULTI_SZ. */
export interface UserEnvironmentEntry {
  readonly name: string
  readonly kind: string
  readonly values: readonly string[]
}

/** Resolves a variable the way the environment block would, for `%NAME%` expansion. */
export type EnvironmentLookup = (name: string) => string | undefined

/**
 * One `reg query` value line: four spaces, name, four spaces, type, four spaces,
 * data. The name and the data may themselves contain spaces, so both sides anchor
 * on the `REG_*` token instead of splitting on whitespace.
 */
const ENTRY_PATTERN = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/

/**
 * Parse the output of `reg query HKCU\Environment`.
 *
 * A REG_MULTI_SZ prints its first entry on the value line and the remaining
 * entries on the following lines, which carry no type token; they are collected
 * until the next value line. Blank lines and the key header are ignored.
 */
export function parseRegQueryEnvironment(stdout: string): UserEnvironmentEntry[] {
  const entries: UserEnvironmentEntry[] = []
  let multiName: string | undefined
  let multiValues: string[] = []
  const flushMulti = (): void => {
    if (multiName === undefined) return
    entries.push({ name: multiName, kind: 'REG_MULTI_SZ', values: multiValues })
    multiName = undefined
    multiValues = []
  }
  for (const line of stdout.split(/\r?\n/)) {
    const match = ENTRY_PATTERN.exec(line)
    const name = match?.[1]
    const kind = match?.[2]
    if (name === undefined || kind === undefined) {
      const continuation = line.trim()
      if (multiName !== undefined && continuation !== '') multiValues.push(continuation)
      continue
    }
    flushMulti()
    const raw = match?.[3] ?? ''
    if (kind === 'REG_MULTI_SZ') {
      multiName = name.trim()
      multiValues = raw === '' ? [] : [raw]
      continue
    }
    entries.push({ name: name.trim(), kind, values: [raw] })
  }
  flushMulti()
  return entries
}

/** Expand `%NAME%` references, leaving an unknown name untouched (the Windows rule). */
export function expandPercentReferences(value: string, lookup: EnvironmentLookup): string {
  return value.replace(/%([^%]+)%/g, (reference: string, name: string) => lookup(name) ?? reference)
}

/**
 * The environment value one registry entry contributes, or `undefined` when it
 * cannot be represented in an environment block (REG_BINARY/REG_NONE) or is empty.
 * REG_MULTI_SZ joins with `;` and REG_DWORD loses its `0x` prefix, matching what
 * a child process would read back.
 */
export function environmentValue(entry: UserEnvironmentEntry, lookup: EnvironmentLookup): string | undefined {
  if (entry.kind === 'REG_BINARY' || entry.kind === 'REG_NONE') return undefined
  const raw = entry.values.join(';')
  let value = raw
  if (entry.kind === 'REG_DWORD') {
    const parsed = Number.parseInt(raw, 16)
    if (Number.isNaN(parsed)) return undefined
    value = String(parsed | 0)
  } else if (entry.kind === 'REG_EXPAND_SZ') {
    value = expandPercentReferences(raw, lookup)
  }
  return value === '' ? undefined : value
}

/**
 * Names the system and the user each contribute a half of. The registry key holds
 * the user half only, so assigning it outright would drop the system directories
 * from `PATH` and its siblings — the process would lose programs the machine's
 * system environment put there. These are appended instead.
 */
const ADDITIVE_NAMES = new Set(['PATH', 'PSMODULEPATH', 'PATHEXT', 'LIB', 'INCLUDE'])

/** The five additive names are all semicolon-separated Windows path lists. */
const ADDITIVE_SEPARATOR = ';'

/**
 * Append the entries of `value` that `existing` does not already carry.
 *
 * The comparison is per entry, never per string. A whole-string `includes` looks
 * like the obvious test and is always true here: the inherited block already
 * ends with the user half, so `existing.includes(value)` matches and the caller
 * would take the overwrite branch instead — dropping every system directory.
 * Windows compares these lists case-insensitively, so the de-duplication does too.
 */
export function appendMissingEntries(existing: string, value: string): string {
  const normalize = (item: string): string => item.trim().toLowerCase()
  const present = new Set(existing.split(ADDITIVE_SEPARATOR).map(normalize).filter((item) => item !== ''))
  const additions = value.split(ADDITIVE_SEPARATOR)
    .filter((item) => item.trim() !== '' && !present.has(normalize(item)))
  if (additions.length === 0) return existing
  const separator = existing.trimEnd().endsWith(ADDITIVE_SEPARATOR) || existing.trim() === '' ? '' : ADDITIVE_SEPARATOR
  return `${existing}${separator}${additions.map((item) => item.trim()).join(ADDITIVE_SEPARATOR)}`
}

/**
 * Write every representable entry into `target`, returning how many landed.
 * Entries are applied one at a time so a `%VAR%` reference may point at a name
 * this same pass already refreshed. Later assignments win, exactly as they would
 * in the block itself — except for the additive names above, where the process's
 * own directories stay in front and only the registry entries it lacks are
 * appended (see {@link appendMissingEntries}).
 */
export function mergeUserEnvironment(
  entries: readonly UserEnvironmentEntry[],
  target: Record<string, string | undefined> = process.env,
  lookup?: EnvironmentLookup,
): number {
  const resolve = lookup ?? ((name: string): string | undefined => target[name])
  let applied = 0
  for (const entry of entries) {
    const value = environmentValue(entry, resolve)
    if (value === undefined) continue
    const existing = target[entry.name]
    if (ADDITIVE_NAMES.has(entry.name.toUpperCase()) && existing !== undefined && existing !== '') {
      target[entry.name] = appendMissingEntries(existing, value)
    } else {
      target[entry.name] = value
    }
    applied += 1
  }
  return applied
}

/** Run `reg query` for the per-user environment; `undefined` when it cannot be read. */
export function readUserEnvironmentBlock(
  executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const result = spawnSync(executable, ['query', 'HKCU\\Environment'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    if (result.error !== undefined || result.status !== 0) return undefined
    return typeof result.stdout === 'string' ? result.stdout : undefined
  } catch {
    // A missing or blocked reg.exe must never stop the application from starting;
    // the stale block is exactly what upstream would have used anyway.
    return undefined
  }
}

/**
 * Refresh `process.env` from the registry, returning how many variables landed
 * (0 when the platform has no such key or it could not be read).
 *
 * Values are decoded as UTF-8. `reg query` writes in the console code page, so a
 * non-ASCII value can arrive mangled; names and the credential-shaped values this
 * exists for are ASCII, and a mangled one simply keeps upstream's stale value.
 */
export function refreshUserEnvironment(block: () => string | undefined = readUserEnvironmentBlock): number {
  if (process.platform !== 'win32') return 0
  const stdout = block()
  if (stdout === undefined) return 0
  return mergeUserEnvironment(parseRegQueryEnvironment(stdout))
}
