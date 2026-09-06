# DSH Build

对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动拉取、构建并发布的仓库。

## 公告（2026-09-06）

- **稳定版**（`dsh-master-latest`）：当前为 **76fda72**，历史会话与新版功能均正常，推荐直接使用。
- **dev 通道**（`dsh-dev-latest`）：每日自动构建上游最新代码，并附带**本地兼容性修复**（解决新版 UI 历史会话消息无法显示的问题），适合尝鲜与测试。
- 稳定版不受每日构建影响；验证 dev 稳定后，才会手动发布到稳定版。

> `update.exe` 可切换更新通道（运行后键盘选择 dev / main）。

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

### 目录结构

```
dsh-portable/
├── dsh.exe        # 启动器（双击运行）
├── update.exe     # 更新器（原地更新）
├── node/          # Node.js 24 运行时
├── node_modules/  # 依赖
├── data/          # 用户数据（DSH_HOME，更新时保留）
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
- 便携包用官方验证过的 `pnpm deploy --legacy --prod --config.node-linker=hoisted` 链，消除 symlink
- 构建产物自动打本地兼容性补丁（`portable/patch-native-code.mjs`，幂等，上游修复后自动跳过）
- 启动器/更新器源码在 `portable/`，workflow 内用 `.NET Framework 4.8` 的 `csc` 编译
- 通知使用 Server3（secrets：`SC3_UID` / `SC3_SENDKEY`），未配置则静默跳过
