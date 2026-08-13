# DSH Build

对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动拉取、构建并发布的仓库。

## 说明

每天定时（UTC 06:00，北京 14:00）检查上游 `master` 分支是否有新提交；有新提交才触发构建，产物发布到 [Releases](https://github.com/citydirector/DSH-build/releases)。

## 产物

每个 Release（tag `dsh-master-latest`）包含两个 zip：

| 产物 | 用途 |
|---|---|
| `dsh-portable-win64-*.zip` | **Windows 绿色便携版**（推荐），解压即用 |
| `dsh-npm-tarballs-*.zip` | npm 全家桶 tarball，离线/自托管分发用 |

## Windows 便携版（推荐）

绿色便携，开箱即用：

1. 下载 `dsh-portable-win64-*.zip`，解压到任意目录（不要放 C 盘程序目录）
2. 双击 `dsh.exe`，自动启动 Web UI 并打开浏览器（默认 `http://127.0.0.1:3080`）
3. 首次使用进入 **Settings → Models** 填 DeepSeek API key

**绿色承诺**：不写注册表、不写 C 盘用户目录、不写系统环境变量。所有数据（配置、会话、凭据）都在程序目录内的 `data/` 文件夹里，删除整个目录即彻底卸载。

### 原地更新

双击 `update.exe`，自动检查最新版本并原地覆盖更新（保留 `data/` 用户数据）。更新前请先关闭 dsh。

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

仓库 Actions 页面 → **Build DSH** → `Run workflow`，立即构建最新 master。

## Workflow 说明

- `.github/workflows/build-harness.yml`：`check`（查上游新提交）→ `npm`（ubuntu 出 tarball）+ `portable`（windows 出便携包）→ `release`（合并发布）
- 便携包用官方验证过的 `pnpm deploy --legacy --prod --config.node-linker=hoisted` 链，消除 symlink
- 启动器/更新器源码在 `portable/`，workflow 内用 `.NET Framework 4.8` 的 `csc` 编译
- 通知使用 Server3（secrets：`SC3_UID` / `SC3_SENDKEY`），未配置则静默跳过
