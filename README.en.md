# DSH Build

[中文](README.md) | English

Automated pull, build, and release of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
Artifacts live in [Releases](https://github.com/citydirector/DSH-build/releases): a Windows portable build, a Windows desktop build (portable, no installer), and the full set of npm tarballs.

## Branches and channels

| | `dev` (default branch) | `main` |
|---|---|---|
| Purpose | Pre-release channel that follows upstream | Verified stable channel |
| Trigger | Daily 06:00 UTC (`schedule`) + manual | Push to `main` (path-filtered) + manual |
| Upstream target | Head of upstream `master` | The commit pinned in `portable/upstream.pin` (reproducible) |
| Publishes to | `dsh-dev-latest` (pre-release) | `dsh-master-latest` (release) |
| Pin updates | Advanced after every successful release | Only on promotion |

- The two channels differ only in where the upstream commit comes from; everything under `portable/` is identical.
- Scheduled runs are skipped only when both the upstream commit and the glue fingerprint (blob digest of this repo minus the pin) match the last release. Manual runs always build.
- Promote by merging `dev` into `main`; the push rebuilds the stable release.
- Do not pin anything older than 0.1.7: those versions have no v3/v4 session codecs.

## Artifacts

| Artifact | What it is |
|---|---|
| `dsh-desktop-win64-*.zip` | **Windows desktop (recommended)**: Electron shell + bundled runtime, unzip and run |
| `dsh-portable-win64-*.zip` | Lighter portable build without Electron; uses your browser |
| `dsh-npm-tarballs-*.zip` | Every `@deepseek-ai/dsh` package as a tarball, for offline or self-hosted installs |

## Windows desktop

1. Unzip to a **short path** such as `D:\dsh-desktop`.
2. Run `DeepSeek Harness.exe` (Web UI on port 19387, so it does not clash with the portable build's 3080).
3. Enter your DeepSeek API key on first use.

Nothing is written outside the folder: all user data lives in `data/` (`DSH_HOME`), and deleting the folder uninstalls it. `update.exe` updates in place from the manifest, keeps `data/`, and backs up first. Design notes, build-time patches, and static checks are in [portable/README-desktop.md](portable/README-desktop.md).

## Windows portable

1. Unzip `dsh-portable-win64-*.zip` anywhere (avoid `C:\Program Files`).
2. Run `dsh.exe`; it starts the Web UI at `http://127.0.0.1:3080` and opens your browser.
3. Enter your DeepSeek API key on first use.

- **In-place updates**: close dsh and run `update.exe`. `data/` is kept and backed up to `data/backups/`.
- **Session migration (v2/v3 → v4)** runs once per `VERSION`. Re-run with `dsh.exe --migrate-sessions`, skip with `DSH_SKIP_SESSION_MIGRATION=1`. Older builds cannot read v4 sessions.
- **Bundle check after updates**: `node portable/check-bundles.mjs <install>\app\node_modules [--profile <name>]` reports bundles your profile selects that the release no longer ships.
- `VERSION` holds the upstream commit; `GLUE` holds this repo's fingerprint, so fixes that only touch the glue still reach users.
- **Slow startup is almost always MCP servers**, not sessions: each MCP plugin waits for its server before activating. Disable servers you rarely use (`disabled: true`) instead of shrinking the reconnect budget.

## Build-time patches

Every patch is idempotent and fails the build when its upstream anchor drifts, so nothing ships half-patched. Patches and their rationale are listed in [portable/README-desktop.md](portable/README-desktop.md) and in each script's header.

## Manual runs

Actions → **Build DSH** → `Run workflow`, with `channel` = `auto` (follow the branch), `main`, or `dev`.

## Local build and checks

```powershell
npm test                            # all patch tests (node --test "tests/*.test.mjs")
node portable/build-desktop.mjs     # desktop build (--skip-build / --skip-package / --no-verify)
node portable/verify-desktop.mjs --dir <staged package>
node portable/check-bundles.mjs <install>\app\node_modules
```

## Layout

- `portable/`: build scripts and patches. `portable/lib/apply-edits.mjs` is the shared "exactly one anchor, idempotent" replacement primitive; a new patch only declares `EDITS`.
- `ci/`: the logic behind each workflow step (bash / pwsh / node); the workflow only orchestrates. Each script's header lists the environment variables it reads.
- `tools/`: field tools outside the pipeline, such as `repair-windows-acl-runner-console.mjs` for already-installed builds.
- `tests/`: one regression test per patch; `npm test` runs them all.
- Comments refer to upstream code by symbol name, never by line number.

## License

[MIT](LICENSE). Upstream deepseek-harness is also MIT.
