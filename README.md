# DSH Build

对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动拉取、构建并发布的仓库。
产物在 [Releases](https://github.com/citydirector/DSH-build/releases)：Windows 便携版、Windows 桌面端（绿色便携）、npm tarball 全家桶。

## 分支与通道

| | `dev`（默认分支） | `main` |
|---|---|---|
| 定位 | 跟随上游的预发布通道 | 验证过的稳定通道 |
| 触发 | 每日 06:00 UTC（`schedule`）+ 手动 | main 被推进（`push`，路径过滤）+ 手动 |
| 目标上游 | 上游 `master` 头 | `portable/upstream.pin` 钉住的提交（**可复现**）|
| 发布到 | `dsh-dev-latest`（pre-release）| `dsh-master-latest`（正式）|
| 写 pin | 每次成功发布后自动推进 | 只在晋升时更新 |

- 两个通道只差「上游提交从哪来」，`portable/` 下的胶水逐字节相同。
- **跳过判定**：自动触发时，只有目标上游提交 + 胶水指纹（本仓库除 pin 外的 blob 摘要）都与上次发布一致才跳过；手动触发一律构建。
- **晋升**：`gh pr create --base main --head dev` 并合并（或直接把 main 对齐到 dev）；main 的 push 会重建稳定版。
- **同通道排队**：workflow 顶层 `concurrency`（`cancel-in-progress: false`）让同通道构建串行，不同通道仍可并行 —— 并发不会互相删 release。
- ⚠️ 别把 pin 退到 0.1.7 之前的提交：那些版本没有 v3/v4 会话编解码。

## 产物

| 产物 | 说明 |
|---|---|
| `dsh-desktop-win64-*.zip` | **Windows 桌面端（绿色便携，推荐）**：Electron 外壳 + 内置运行时，解压即用 |
| `dsh-portable-win64-*.zip` | Windows 绿色便携版：不带 Electron，用系统浏览器，更轻量 |
| `dsh-npm-tarballs-*.zip` | npm 全家桶 tarball，离线 / 自托管分发 |

## Windows 桌面端（绿色便携，推荐）

`dsh-desktop-win64-*.zip`：Electron 外壳 + 内置 dsh 运行时 —— 自带窗口、不占用系统浏览器，是用 DSH 的完整体验。

1. 解压到**短路径**目录（如 `D:\dsh-desktop`）
2. 双击 `DeepSeek Harness.exe`：自带窗口起 Web UI（默认端口 19387，与便携版的 3080 不冲突）
3. 首次使用填 DeepSeek API key

比便携版大约多一个 Electron（zip 约 368MB vs 178MB）；绿色承诺、桌面端 `update.exe`（清单驱动、可切通道）、构建期补丁与静态验收的细节见 [portable/README-desktop.md](portable/README-desktop.md)。

- **不打包 `data/`**：`DSH_HOME`（安装目录内的 `data/`）由 app 首启创建，首启即**官方默认 profile**。人设 / preset / 插件属于用户数据 —— 既不进仓库，也不进发行包。
- 包内 `update.exe` 读包内 `update.json`，**只认 `dsh-desktop-win64-*` 资产**，不会误拉便携版。
- 覆盖 = **逐顶层条目镜像**（`robocopy /MIR`），清单里 `preserve: ["data"]` 声明的用户状态整棵不动；覆盖前自动备份。
- 静态验收 `portable/verify-desktop.mjs`（CI 里跑）：入口与标记文件、无更新来源、迁移器、运行时补丁在产物里、不打包 `data/` 且不含个人数据。

## Windows 便携版（绿色、轻量）

1. 解压 `dsh-portable-win64-*.zip` 到任意目录（不建议放 C 盘程序目录）
2. 双击 `dsh.exe`：自动起 Web UI（默认 `http://127.0.0.1:3080`）并打开浏览器
3. 首次使用填 DeepSeek API key

**绿色承诺**：不写注册表、不写 C 盘用户目录、不写系统环境变量；所有数据都在程序目录内的 `data/`（DSH_HOME），删目录即彻底卸载。

- **原地更新**：双击 `update.exe`，自动检查并原地覆盖（保留 `data/`；覆盖前备份到 `data/backups/`；`update.exe` 自身一并更新）。更新前先关闭 dsh。
- **会话格式自动迁移（v2/v3 → v4）**：每个 `VERSION` 首次启动跑一次，逐会话「写打开后立即关闭」发布 v4 generation；旧代际文件原样保留（要回滚就删掉新代际文件）。报告在 `data/.migrations/tmp/`；`dsh.exe --migrate-sessions` 可重跑，`DSH_SKIP_SESSION_MIGRATION=1` 可跳过。⚠️ 迁移后旧版构建读不出 v4 会话。
- **更新后自查随包是否撑得住你的 bundle**：profile 的 `dsh.profile.bundles` 与「是否随包」是解耦的，选中但没随包的 bundle 只会在启动时行加载失败。用 `node portable/check-bundles.mjs <安装目录>\app\node_modules [--profile <profile>]`（退出码 `0` 干净 / `1` 有悬空 bundle / `2` 名单解析失败；`--self-test` 自证会报错）。CI 的 portable job 在 boot 冒烟后也会跑。

### 目录结构

```
dsh-portable/
├── dsh.exe        # 启动器（首启自动迁移会话格式）
├── update.exe     # 更新器（原地更新，保留 data/）
├── node/          # Node.js 运行时
├── app/           # dsh 本体与依赖（app/node_modules）
├── data/          # 用户数据（DSH_HOME，更新时保留）
└── VERSION        # 当前构建对应的上游 commit sha
```

## npm tarball 版

`dsh-npm-tarballs-*.zip` 内含 `dist/npm/*.tgz`（`@deepseek-ai/dsh` 家族全部打包产物），用于离线安装或自托管 registry。

## 手动触发

Actions → **Build DSH** → `Run workflow`，`channel` 可选 `auto`（跟随所在分支）/ `main` / `dev`；手动触发一律构建。在临时分支上选 `auto` 走 dev 通道（验证流水线用，不碰稳定标签）。

## Workflow

`.github/workflows/build-harness.yml`：`check`（解析目标上游 + 跳过判定）→ `npm` / `portable` / `desktop`（三个产物）→ `release`（合并发布；dev 顺带推进 pin）→ `notify-failure`。

- `check` 按 `github.ref_name` 定通道；下游 job 一律用 `check` 解析出的**同一个**上游 sha 检出（否则 check 与真正构建的不是同一提交）。
- Release body 末尾四行机器可读：`upstream:` / `glue:` / `channel:` / `built-from:`（跳过判定读前两行）。
- pnpm 固定在 workflow 顶层 `PNPM_VERSION`（**11.27.1**）：11.7.0 有 hoisted 缺陷（[pnpm#12880](https://github.com/pnpm/pnpm/issues/12880)），12.x 又在工作区里跑 `pnpm run/exec` 必失败（内部触发已被自己移除的 `verify-deps-before-run-install`）。每次调用带 `--pm-on-fail=ignore`，checkout 后把上游 `packageManager` 对齐到该版本。
- 便携包：`pnpm --filter @deepseek-ai/dsh deploy --legacy --config.node-linker=hoisted`（**不加** `--prod`：运行时插件在 devDependencies）+ `patch-peers/patch-dep` 补齐 deploy 漏掉的依赖 + 真 boot 冒烟。
- 构建期给上游产物打本地兼容补丁（`portable/patch-native-code.mjs`，幂等、可自愈）：lossless-JSON 守卫 + 迁移白名单 kind；单测 `tests/patch-native-code.test.mjs`。
- 会话迁移器由 `portable/build-migrator.mjs` 把上游脚本打成单文件 ESM 随包分发。
- 桌面端：源码补丁 → `build:official` → 打在已构建 lib 上的补丁 → 迁移器 → `package:win:x64:unsigned --dir` → 组装绿色包 → 静态验收。

## 本地构建 / 验收

```powershell
node portable/build-desktop.mjs     # 桌面端（另有 --skip-build / --skip-package / --no-verify）
node portable/verify-desktop.mjs --dir <staged package>
node portable/check-bundles.mjs <安装目录>\app\node_modules
```
