# DSH Build

对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动拉取、构建并发布的仓库。

## 公告（2026-09-24）

- **两个通道现在都跑上游 `477b4f4`（0.1.7-rc.2）**：`dsh-master-latest`（稳定，正式）由 **main** 分支发出；`dsh-dev-latest`（pre-release）由 **dev** 分支每日跟随上游。两者只差"上游提交从哪来"，胶水完全一致。
- **分支 = 通道**（2026-09-24 重构，见下节）：`dev` 是默认分支、每日自动跟随上游；`main` 只在晋升时动。
- **首次以新版本启动时会自动把本地 v2/v3 会话迁移到 v4**（一次性、可回滚），见下文。

> `update.exe` 可切换更新通道（运行后键盘选择 dev / main）。

## 分支与通道（2026-09-24 起）

| | **`dev`（默认分支）** | **`main`** |
|---|---|---|
| 定位 | 跟随上游的预发布通道 | 你验证过的稳定通道 |
| 触发 | 每日 06:00 UTC（`schedule`）+ 手动 | main 被推进时（`push`，路径过滤）+ 手动 |
| 目标上游 | `master` 头（上游一有新提交就跟上） | **`portable/upstream.pin` 里钉住的提交** |
| 发布到 | `dsh-dev-latest`（pre-release） | `dsh-master-latest`（正式） |
| 何时写 pin | 每次成功发布后自动推进 | 只在你晋升时更新 |

- **通道由你所在的分支决定**，不再由事件类型猜：在 dev 上跑（含每日任务）→ dev 通道；在 main 上跑 → 稳定通道；临时分支上手动 dispatch 也走 dev 通道（验证用，不碰稳定标签）。
- **`portable/upstream.pin` 是一行上游 commit sha**，含义是"本通道当前产物对应的上游提交"。它让 `dsh-master-latest` **可复现**——随时能重建出同一个提交的产物，而不是"当时的上游 HEAD 是什么就是什么"。dev 侧的 pin 只在上传成功后推进，所以它不会出现"pin 指向 A、线上是 B"的错位。
- **跳过判定**：自动触发时，若目标提交与上次发布相同就跳过（省 CI）；**手动触发一律构建**。
- **晋升**：dev 验证 OK → `gh pr create --base main --head dev` → 合并 → main 的 push 自动重建稳定版。PR 里只有胶水 + 一行 pin，可 review。
- ⚠️ **别把 pin 往回退到 0.1.7 之前的提交**：那些版本没有 v3/v4 会话编解码，会把已迁移到 v4 的会话读成"未知的新代际"。

### 构建链更新（2026-09-24）

- pnpm 从 11.7.0 升到 **11.27.1**。11.7.0 在 `node-linker=hoisted` 下有缺陷（[pnpm#12880](https://github.com/pnpm/pnpm/issues/12880)，11.25.0 修复）：把已构建的包复制到其它 hoisted 位置时整目录替换，删掉并发兄弟的 `_tmp_*` 暂存目录，报 `ERR_PNPM_ENOENT rename '.../_tmp_...' -> '.../esbuild'`；更糟的是替换本身是静默的，成功的那几次也会删掉目标下嵌套的 `node_modules`。这就是 09-23 那次每日构建失败的原因。
- **为什么不是 12.x**：pnpm 12.6.0（12.0–12.6 全线）在**工作区**里跑 `pnpm run <script>` / `pnpm exec` 必然失败——它内部那次"依赖校验安装"带上了已经被自己移除的旧选项 `verify-deps-before-run-install`，再被自己的严格选项校验拒绝（`[ERROR] Unknown option: 'verify-deps-before-run-install'`）。本地最小复现：`pnpm-workspace.yaml` 里只要有 `packages:` 就触发；`--config.*` 之类的外部覆盖救不了（那次调用在 pnpm 进程内部，拿不到命令行开关）。所以停在 11.x 末版 11.27.1。
- 上游 `package.json` 仍把 `packageManager` 钉在 `pnpm@11.7.0`，不处理的话 pnpm 会「自动下载并回退」到旧版（默认 `pmOnFail=download`），缺陷照旧——`pnpm run` 内部那次安装更是拿不到命令行开关。所以两个 job 都在 checkout 后把 `packageManager` 对齐到 11.27.1（该字段不进任何产物），并且每次 pnpm 调用仍带 `--pm-on-fail=ignore`，防止 pnpm 把 `packageManagerDependencies` 写进锁文件、把 `--frozen-lockfile` 顶掉。
- GitHub Actions 全部升到当前大版本：`actions/checkout@v7`、`actions/setup-node@v7`、`pnpm/action-setup@v6`、`actions/upload-artifact@v7`、`actions/download-artifact@v8`。
- 二次 checkout 自己的仓库改为显式 `ref: ${{ github.sha }}`：不带 ref 时取的是默认分支，非 main 分支的构建会拿 main 的旧源码，分支验证会失真。
- 失败通知改为读取失败步骤的真实日志（`gh run view --log-failed`）；以前只读 smoke artifact，install/deploy 阶段失败时摘要永远是空的。


## 发布通道

只保留两个 Release 标签，全部产物在 [Releases](https://github.com/citydirector/DSH-build/releases)：

- **`dsh-master-latest`**（正式）：由 `main` 分支发出，上游提交钉在 `portable/upstream.pin`，**可复现**。
- **`dsh-dev-latest`**（pre-release）：由 `dev` 分支每日自动构建上游最新代码并打本地兼容性补丁。

两者的区别只是"上游提交从哪来"，`portable/` 下的胶水（补丁、迁移器、启动器）逐字节相同。

## 产物

每个 Release 包含两个 zip：

| 产物 | 用途 |
|---|---|
| `dsh-portable-win64-*.zip` | **Windows 绿色便携版**（推荐），解压即用 |
| `dsh-npm-tarballs-*.zip` | npm 全家桶 tarball，离线/自托管分发用 |

## Windows 便携版（推荐）

绿色便携，开箱即用：

1. 下载 `dsh-portable-win64-*.zip`，解压到任意目录（不建议放 C 盘程序目录）
2. 双击 `dsh.exe`，自动启动 Web UI 并打开浏览器（默认 `http://127.0.0.1:3080`）
3. 首次使用需填 DeepSeek API key

**绿色承诺**：不写注册表、不写 C 盘用户目录、不写系统环境变量。所有数据（配置、会话、凭据）都在程序目录内的 `data/` 文件夹里，删除整个目录即彻底卸载。

### 原地更新

双击 `update.exe`，自动检查最新版本并原地覆盖更新（保留 `data/` 用户数据）。更新前请先关闭 dsh。备份放在 `data/backups/` 。当前及后面版本里 `update.exe` 执行更新时同时会自我更新。

### 会话格式自动迁移（本地 v2/v3 → v4）

上游只在**写打开**（resume）时才把旧代际会话升级到当前代际，读取是只读的；所以升级到 v4 构建后，需要有人把本机全部会话补迁移一遍 —— 便携版在 `dsh.exe` 启动时自动做这件事。

- **何时跑**：每个 `VERSION`（构建提交号）第一次启动时跑一次，之后静默跳过。
- **做什么**：逐会话「打开写句柄后立即关闭」，由上游会话持久化层发布一份**当前代际（v4）的 generation 文件**。已是 v4 的会话只读打开，天然幂等。
- **可回滚**：历史代际文件（`session.jsonl.zstd`、`session.v2.jsonl.zstd`、`session.v3.jsonl.zstd`）**原样保留**，迁移只是新增 `session.v4.jsonl.zstd`。要回退旧版，删掉各会话目录下的新代际文件即可。
- **失败隔离**：单个会话失败不影响其它会话，也不阻断启动（新版仍能按旧代际读取未升级的会话）。报告落在 `data/.migrations/tmp/`（`migration.log` + `summary.json`）。
- **重跑**：`dsh.exe --migrate-sessions`（只迁移、不启动；会忽略已写的标记）。
- **跳过**：设环境变量 `DSH_SKIP_SESSION_MIGRATION=1`。
- **前置条件**：`portable/patch-native-code.mjs` 的补丁 2 —— 改动点是 v2→v3 的白名单补 `instruction-hint`，覆盖面是**整条 v2→v3→v4 链**（catalog 的 migrations 图链式推进，v2 会话必须先过 v2→v3；也就是批量迁移器能 0 拒绝的前置条件）。否则含旧 AGENTS.md 提示消息的会话会在迁移时报 `cannot safely transform unclassified message source`。构建流程已自动应用。
- ⚠️ **单向性**：迁移完成后，旧版（如仍停在 76fda72 的 `dsh-master-latest`）**读不出 v4 会话**（"future highest generation" 会被拒绝）。所以要么留在 dev 通道，要么先回滚再切回稳定版。

### 更新后自查：随包是否撑得住你的 bundle

插件面板的分区靠两个**硬编码名单**（客户端 `BUILTIN_PROFILE_BUNDLES`、宿主 `OPTIONAL_BUNDLES`），而 profile 的 `dsh.profile.bundles` 与 `dependencies` 是**解耦**的：选中一个 bundle ≠ 安装它，能否解析完全看随包内容；面板上的开关（`setBundleEnabled`）只改 `dsh.profile.bundles`、**不会安装**。所以一个"选中但没随包"的 bundle 只会在启动时行加载失败——只有你机器上看得见。

`portable/check-bundles.mjs` 就是查这个（名单从**已部署的包**里解析，不写死）：

```powershell
# 只验随包（DEFAULT ∪ OPTIONAL ∪ BUILTIN 是否都在 app/node_modules 里）
node D:\DSHWorkspace\DSH-Protable\DSH-build\portable\check-bundles.mjs 'D:\dsh-portable\app\node_modules'

# 连你自己的 profile 一起验：每个声明的 bundle 靠谁兜住
node D:\DSHWorkspace\DSH-Protable\DSH-build\portable\check-bundles.mjs 'D:\dsh-portable\app\node_modules' --profile 'D:\dsh-portable\data\profiles\web'

# 证明它真的会报错（拿假树跑一遍，缺 bundle 时必须返回 1）
node ...\check-bundles.mjs --self-test
```

退出码：`0` 干净、`1` 有悬空 bundle、`2` 名单解析失败（上游改了写法，需人工看）。CI 的 portable job 在 boot 冒烟之后也跑一遍（拿随包的默认 profile 当被测对象）。


### 目录结构

```
dsh-portable/
├── dsh.exe        # 启动器（双击运行；首次以新版本启动时自动迁移会话格式）
├── update.exe     # 更新器（原地更新）
├── node/          # Node.js 24 运行时（只有 node.exe）
├── app/           # dsh 本体与依赖（app/node_modules）
│   └── migrate-sessions-v4.mjs   # 会话代际迁移器（构建期由上游脚本打包生成）
├── data/          # 用户数据（DSH_HOME，更新时保留）
│   └── .migrations/              # 会话迁移标记与报告（每个 VERSION 一份）
└── VERSION        # 当前构建的 commit sha
```

## npm tarball 版

`dsh-npm-tarballs-*.zip` 内含 `dist/npm/*.tgz`（`@deepseek-ai/dsh` 家族全部打包产物），用于离线安装或自托管 registry：

```bash
npm i ./dist/npm/deepseek-ai-dsh-0.1.0-rc.5.tgz
```

## 手动触发

Actions 页面 → **Build DSH** → `Run workflow`，**在哪个分支上点就是哪个通道**（手动触发一律构建，不跳过）：

- 在 `dev` 上点 → 构建上游最新，发 `dsh-dev-latest`
- 在 `main` 上点 → 构建 `portable/upstream.pin` 钉的那个提交，发 `dsh-master-latest`
- 在临时分支上点 → 按 dev 通道跑（验证流水线改动用，不碰稳定标签）

## Workflow 说明

`.github/workflows/build-harness.yml`：`check`（解析目标上游提交 + 跳过判定）→ `npm`（ubuntu 出 tarball）+ `portable`（windows 出便携包）→ `release`（合并发布；dev 通道顺带推进 pin）→ `notify-failure`（独立 job，任一失败都通知）

- `check` 用 `github.ref_name` 定通道：`main` → 目标 = `portable/upstream.pin`；其它 → 目标 = 上游 `master` 头
- 下游所有 job 都用 `check` 解析出的**那个**上游 sha 检出上游，不用 `master`——否则 check 与真正构建的可能不是同一个提交
- Release body 末尾有机器可读三行（`upstream:` / `channel:` / `built-from:`），跳过判定读的就是 `upstream:` 行
- dev 发布成功后自动提交 `chore(dev): track upstream <sha>`（`GITHUB_TOKEN` 推送不会再触发 workflow，不会自我循环）
- pnpm 版本由 workflow 顶层 `PNPM_VERSION` 单一控制（当前 11.27.1）；每次调用都带 `--pm-on-fail=ignore`，并且 checkout 后会把上游 `packageManager` 对齐到该版本（不这么做会被静默回退到 11.7.0）
- 便携包用 `pnpm --filter @deepseek-ai/dsh deploy --legacy --config.node-linker=hoisted` 链（**不加** `--prod`：dsh 运行时插件在 devDependencies，靠 cordis 动态加载），再用 `patch-peers.mjs` / `patch-dep.mjs` 补齐 deploy 系统性漏掉的依赖，最后跑真 boot 冒烟测试
- 构建产物自动打本地兼容性补丁（`portable/patch-native-code.mjs`，幂等、可自愈）：lossless-JSON 守卫（含字面量内转义）+ 迁移白名单 kind；单测在 `tests/patch-native-code.test.mjs`，CI 里跑
- boot 冒烟之后跑 `portable/check-bundles.mjs`：随包必须撑得住它宣称的 bundle（名单从已部署的包里解析），否则构建失败
- 会话迁移器由 `portable/build-migrator.mjs` 在构建期把上游 `scripts/migrate-sessions-to-v4.ts` 打成单文件 ESM（相对 import 内联、`@deepseek-ai/*` 保持 external），随包分发
- 启动器/更新器源码在 `portable/`，workflow 内用 `.NET Framework 4.8` 的 `csc` 编译
- 通知使用 Server3（secrets：`SC3_UID` / `SC3_SENDKEY`），未配置则静默跳过
