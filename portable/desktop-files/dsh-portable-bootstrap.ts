/**
 * DSH-build portable bootstrap: keep every byte of state beside the executable.
 *
 * Imported before any other desktop module so that DSH_HOME and Electron's own
 * user-data paths are decided before anything reads them. A portable package
 * ships a `portable.flag` marker next to the executable; without that marker
 * this module does nothing and the application behaves exactly as upstream.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { app } from 'electron'

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

/** Apply the portable layout when the package carries its marker file. */
export function applyPortableBootstrap(): PortableBootstrapResult {
  const exeDirectory = dirname(process.execPath)
  if (!existsSync(join(exeDirectory, PORTABLE_FLAG))) return { portable: false }
  const dataRoot = join(exeDirectory, 'data')
  mkdirSync(dataRoot, { recursive: true })
  process.env.DSH_HOME = dataRoot
  redirectElectronPaths(dataRoot)
  const migrationRan = migrateSessionsOnce(dataRoot, exeDirectory)
  console.info(`portable bootstrap: data root ${dataRoot}${migrationRan ? ' (session migration ran)' : ''}`)
  return { portable: true, dataRoot, migrationRan }
}

export const portableBootstrap = applyPortableBootstrap()
