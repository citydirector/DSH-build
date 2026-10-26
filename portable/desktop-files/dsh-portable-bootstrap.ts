/**
 * DSH-build portable bootstrap: keep every byte of state beside the executable.
 *
 * Imported before any other desktop module so that DSH_HOME and Electron's own
 * user-data paths are decided before anything reads them. A portable package
 * ships a `portable.flag` marker next to the executable; without that marker
 * this module does nothing and the application behaves exactly as upstream.
 * It also points the XDG base directories at the data root, so XDG-following
 * plugins stay inside the package too, and refreshes `process.env` from the
 * Windows per-user environment registry key (see `dsh-user-environment.ts`) so a
 * value the user changed after logon is visible without a restart.
 *
 * Two one-shot migrations run here, both keyed on the packaged VERSION so a new
 * package runs them exactly once: the session generation upgrade, and the profile
 * configuration migration. The latter used to live in update.exe's plugin preflight,
 * which meant a failed preflight silently left the old configuration behind and the
 * freshly installed runtime then failed to mount its presets.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { refreshUserEnvironment } from './dsh-user-environment.ts'

/** Marker file that opts this installation into the package-local data root. */
export const PORTABLE_FLAG = 'portable.flag'

/** Directory, relative to the data root, that records one-shot migrations. */
export const MIGRATION_MARKER_DIRECTORY = '.migrations'

/** Outcome of bootstrapping one process. */
export interface PortableBootstrapResult {
  readonly portable: boolean
  readonly dataRoot?: string
  readonly migrationRan?: boolean
}

/** Electron-owned directories that must move under the package for a green install. */
const ELECTRON_PATH_NAMES = ['userData', 'sessionData', 'cache', 'logs', 'crashDumps'] as const

function readVersion(exeDirectory: string): string {
  try {
    return readFileSync(join(exeDirectory, 'VERSION'), 'utf8').trim()
  } catch {
    return app.getVersion()
  }
}

/** Point every Electron-owned directory at the package instead of the user profile. */
function redirectElectronPaths(dataRoot: string): void {
  for (const name of ELECTRON_PATH_NAMES) {
    const target = join(dataRoot, 'electron', name)
    mkdirSync(target, { recursive: true })
    app.setPath(name, target)
  }
}

/**
 * XDG base directories, as `[variable, data-root subdirectory, home fallback]`.
 * Plugins that follow XDG (billion-context writes its log, config, session index
 * and MITM CA through these) otherwise fall back to the user profile.
 */
const XDG_DIRECTORIES = [
  ['XDG_CONFIG_HOME', 'config', '.config'],
  ['XDG_DATA_HOME', 'data', join('.local', 'share')],
  ['XDG_STATE_HOME', 'state', join('.local', 'state')],
  ['XDG_CACHE_HOME', 'cache', '.cache'],
] as const

/** Per-application folders carried over from the user profile on first portable launch. */
const XDG_CARRY_OVER = ['billion-context'] as const

/**
 * Keep XDG-following plugins inside the package. A variable the user already set is
 * respected. Each carried-over folder is copied (never moved) once, when the package
 * copy does not exist yet, so existing plugin state such as compressed-session indexes
 * survives the switch; the user-profile original stays until the user deletes it.
 */
function redirectXdgPaths(dataRoot: string): void {
  for (const [variable, subdirectory, fallback] of XDG_DIRECTORIES) {
    if (process.env[variable]?.trim()) continue
    const target = join(dataRoot, 'xdg', subdirectory)
    mkdirSync(target, { recursive: true })
    process.env[variable] = target
    for (const name of XDG_CARRY_OVER) {
      const legacy = join(homedir(), fallback, name)
      const destination = join(target, name)
      if (!existsSync(legacy) || existsSync(destination)) continue
      try {
        cpSync(legacy, destination, { recursive: true, errorOnExist: false })
      } catch (error) {
        console.error(`portable bootstrap: could not copy ${legacy}: ${String(error)}`)
      }
    }
  }
}

/**
 * Give plugins that spawn their own Node process (billion-context's proxy) the
 * packaged Node runtime instead of whatever `node.exe` comes first on PATH, which may
 * be absent, a system install, or not Node at all. A user-set value is respected.
 */
function pinPluginNodeRuntime(): void {
  if (process.env.BILLION_CONTEXT_NODE?.trim()) return
  const bundled = join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin',
    process.platform === 'win32' ? 'node.exe' : 'node')
  process.env.BILLION_CONTEXT_NODE = existsSync(bundled) ? bundled : process.execPath
}

/** Run the bundled batch migrator once per packaged runtime version. */
function migrateSessionsOnce(dataRoot: string, exeDirectory: string): boolean {
  const version = readVersion(exeDirectory)
  const markerDirectory = join(dataRoot, MIGRATION_MARKER_DIRECTORY)
  const marker = join(markerDirectory, `session-v4-${version}.done`)
  if (existsSync(marker)) return false
  const migrator = join(process.resourcesPath, 'dsh-build', 'migrate-sessions-v4.mjs')
  if (!existsSync(migrator)) return false
  const result = spawnSync(process.execPath, [migrator, '--sessions-dir', join(dataRoot, 'sessions')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dataRoot },
    stdio: 'ignore',
  })
  mkdirSync(markerDirectory, { recursive: true })
  if (result.status !== 0) {
    console.error(`portable bootstrap: session migration exited with status ${String(result.status)}`)
    return false
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`)
  return true
}

/**
 * Migrate every profile's cordis.patch.yml onto the packaged runtime's own vocabulary.
 *
 * Upstream renames config keys and drops subpath exports between versions, and the
 * profiles under `data/profiles` are hand-written files that do not travel with a
 * package. When they lag behind, mounting a preset throws — and a runtime without a
 * mounted preset cannot create a session at all, which is what the broken dev upgrade
 * looked like. Doing it here, after the new package is in place, means the runtime
 * doing the judging is the one that will actually boot, and one launch is enough.
 *
 * Failures never block startup: the migrator reports per-profile problems and this
 * function only records a marker on success.
 */
function migrateProfilesOnce(dataRoot: string, exeDirectory: string): boolean {
  const version = readVersion(exeDirectory)
  const markerDirectory = join(dataRoot, MIGRATION_MARKER_DIRECTORY)
  const marker = join(markerDirectory, `profile-compat-${version}.done`)
  if (existsSync(marker)) return false
  const migrator = join(process.resourcesPath, 'dsh-build', 'migrate-profiles.mjs')
  if (!existsSync(migrator)) return false
  const runtimeDirectory = join(process.resourcesPath, 'app.asar', 'dsh')
  if (!existsSync(runtimeDirectory)) return false
  const result = spawnSync(process.execPath, [migrator, '--home', dataRoot, '--runtime', runtimeDirectory], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dataRoot },
    stdio: 'inherit',
  })
  mkdirSync(markerDirectory, { recursive: true })
  if (result.status !== 0) {
    console.error(`portable bootstrap: profile migration exited with status ${String(result.status)}`)
    return false
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`)
  return true
}

/**
 * Apply the portable layout when the package carries its marker file.
 *
 * The environment refresh runs first, before this module assigns anything of its
 * own, so a variable the user configured wins over our defaults — the same order
 * the portable launcher uses. It is deliberately part of the portable bootstrap:
 * a package without `portable.flag` behaves exactly as upstream.
 */
export function applyPortableBootstrap(): PortableBootstrapResult {
  const exeDirectory = dirname(process.execPath)
  if (!existsSync(join(exeDirectory, PORTABLE_FLAG))) return { portable: false }
  const refreshed = refreshUserEnvironment()
  const dataRoot = join(exeDirectory, 'data')
  mkdirSync(dataRoot, { recursive: true })
  process.env.DSH_HOME = dataRoot
  redirectElectronPaths(dataRoot)
  redirectXdgPaths(dataRoot)
  pinPluginNodeRuntime()
  const migrationRan = migrateSessionsOnce(dataRoot, exeDirectory)
  const profilesMigrated = migrateProfilesOnce(dataRoot, exeDirectory)
  console.info(`portable bootstrap: data root ${dataRoot} (environment refreshed: ${refreshed})${migrationRan ? ' (session migration ran)' : ''}${profilesMigrated ? ' (profile migration ran)' : ''}`)
  return { portable: true, dataRoot, migrationRan }
}

export const portableBootstrap = applyPortableBootstrap()
