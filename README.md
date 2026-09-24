# DSH Build

对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动拉取、构建并发布的仓库。

## 公告（2026-09-24）

- **稳定版**（`dsh-master-latest`）：当前为 **76fda72**（上游 09-03）。⚠️ 它**没有 v3/v4 会话编解码**，装它会读不出本机已有的 v3 会话 —— 要更新只能走 dev 通道。
- **dev 通道**（`dsh-dev-latest`）：每日自动构建上游最新代码（含会话格式 v4、profile 设置、声明式 Agent 预设），并附带**本地兼容性修复**。
- **首次以 dev 版启动时会自动把本地 v2/v3 会话迁移到 v4**（一次性、可回滚），见下文。
- 稳定版不受每日构建影响；验证 dev 稳定后，才会手动发布到稳定版。

> `update.exe` 可切换更新通道（运行后键盘选择 dev / main）。

### 构建链更新（2026-09-24）

- pnpm 从 11.7.0 升到 **11.27.1**。11.7.0 在 `node-linker=hoisted` 下有缺陷（[pnpm#12880](https://github.com/pnpm/pnpm/issues/12880)，11.25.0 修复）：把已构建的包复制到其它 hoisted 位置时整目录替换，删掉并发兄弟的 `_tmp_*` 暂存目录，报 `ERR_PNPM_ENOENT rename '.../_tmp_...' -> '.../esbuild'`；更糟的是替换本身是静默的，成功的那几次也会删掉目标下嵌套的 `node_modules`。这就是 09-23 那次每日构建失败的原因。
- **为什么不是 12.x**：pnpm 12.6.0（12.0–12.6 全线）在**工作区**里跑 `pnpm run <script>` / `pnpm exec` 必然失败——它内部那次"依赖校验安装"带上了已经被自己移除的旧选项 `verify-deps-before-run-install`，再被自己的严格选项校验拒绝（`[ERROR] Unknown option: 'verify-deps-before-run-install'`）。本地最小复现：`pnpm-workspace.yaml` 里只要有 `packages:` 就触发；`--config.*` 之类的外部覆盖救不了（那次调用在 pnpm 进程内部，拿不到命令行开关）。所以停在 11.x 末版 11.27.1。
- 上游 `package.json` 仍把 `packageManager` 钉在 `pnpm@11.7.0`，不处理的话 pnpm 会「自动下载并回退」到旧版（默认 `pmOnFail=download`），缺陷照旧——`pnpm run` 内部那次安装更是拿不到命令行开关。所以两个 job 都在 checkout 后把 `packageManager` 对齐到 11.27.1（该字段不进任何产物），并且每次 pnpm 调用仍带 `--pm-on-fail=ignore`，防止 pnpm 把 `packageManagerDependencies` 写进锁文件、把 `--frozen-lockfile` 顶掉。
- GitHub Actions 全部升到当前大版本：`actions/checkout@v7`、`actions/setup-node@v7`、`pnpm/action-setup@v6`、`actions/upload-artifact@v7`、`actions/download-artifact@v8`。
- 二次 checkout 自己的仓库改为显式 `ref: ${{ github.sha }}`：不带 ref 时取的是默认分支，非 main 分支的构建会拿 main 的旧源码，分支验证会失真。
- 失败通知改为读取失败步骤的真实日志（`gh run view --log-failed`）；以前只读 smoke artifact，install/deploy 阶段失败时摘要永远是空的。


## 发布通道

- **稳定版 `dsh-master-latest`**：手动发布，当前固定为 76fda72。
- **每日 `dsh-dev-latest`**（pre-release）：每天 UTC 06:00 自动构建上游最新代码并打本地兼容性补丁。
- 所有产物发布到 [Releases](https://github.com/citydirector/DSH-build/releases)。

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
- **前置条件**：`portable/patch-native-code.mjs` 的补丁 2（v2→v3 白名单补 `instruction-hint`）—— 否则含旧 AGENTS.md 提示消息的会话会在迁移时报 `cannot safely transform unclassified message source`。构建流程已自动应用。
- ⚠️ **单向性**：迁移完成后，旧版（如仍停在 76fda72 的 `dsh-master-latest`）**读不出 v4 会话**（"future highest generation" 会被拒绝）。所以要么留在 dev 通道，要么先回滚再切回稳定版。


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

仓库 Actions 页面 → **Build DSH** → `Run workflow`，立即构建（dev 分支默认；main 分支手动发布稳定版）。

## Workflow 说明

- `.github/workflows/build-harness.yml`：`check`（查上游新提交）→ `npm`（ubuntu 出 tarball）+ `portable`（windows 出便携包）→ `release`（合并发布）
- 每日自动构建发布到 `dsh-dev-latest`（pre-release）；main 手动触发发布到 `dsh-master-latest`（稳定版）
- pnpm 版本由 workflow 顶层 `PNPM_VERSION` 单一控制（当前 11.27.1）；每次调用都带 `--pm-on-fail=ignore`，并且 checkout 后会把上游 `packageManager` 对齐到该版本（不这么做会被静默回退到 11.7.0）
- 便携包用 `pnpm --filter @deepseek-ai/dsh deploy --legacy --config.node-linker=hoisted` 链（**不加** `--prod`：dsh 运行时插件在 devDependencies，靠 cordis 动态加载），再用 `patch-peers.mjs` / `patch-dep.mjs` 补齐 deploy 系统性漏掉的依赖，最后跑真 boot 冒烟测试
- 构建产物自动打本地兼容性补丁（`portable/patch-native-code.mjs`，幂等，上游修复后自动跳过）：lossless-JSON 守卫 + v2→v3 迁移 kind 白名单
- 会话迁移器由 `portable/build-migrator.mjs` 在构建期把上游 `scripts/migrate-sessions-to-v4.ts` 打成单文件 ESM（相对 import 内联、`@deepseek-ai/*` 保持 external），随包分发
- 启动器/更新器源码在 `portable/`，workflow 内用 `.NET Framework 4.8` 的 `csc` 编译
- 通知使用 Server3（secrets：`SC3_UID` / `SC3_SENDKEY`），未配置则静默跳过
