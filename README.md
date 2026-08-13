# DSH Build

对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动拉取、构建并发布的仓库。

## 说明

每天定时（UTC 06:00）检查上游 `master` 分支是否有新提交；有新提交才触发构建，并把构建产物发布到 [Releases](https://github.com/citydirector/DSH-build/releases)。

## 产物

- Release tag：`dsh-master-latest`（每次重建，固定 tag）
- 内容：`dist/npm/*.tgz`（`@deepseek-ai/dsh` 家族的 npm 打包产物）

## 手动触发

仓库 Actions 页面 → **Build DSH** → `Run workflow`，即可立即构建最新 master。

## 安装

下载 Releases 里的 zip，解压后在项目目录安装 tarball：

```bash
npm i ./dist/npm/<package>.tgz
# 或
pnpm add ./dist/npm/<package>.tgz
```

## Workflow 说明

- `.github/workflows/build-harness.yml`：定时 + 手动触发，检查上游新提交后执行 `pnpm install` → `pnpm run build` → `pnpm run release:pack`，产物打包 zip 发布到 Releases。
- 通知使用 Server3（secrets：`SC3_UID` / `SC3_SENDKEY`），未配置则静默跳过。
