#!/usr/bin/env bash
# release job：删旧 Release（若有）→ 用 artifacts/*/*.zip 建新 Release。
# 输入（env）：RELEASE_TAG, CHANNEL, UPSTREAM_SHA, GLUE, GLUE_SHA（本仓库 github.sha）, GH_TOKEN, GITHUB_REPOSITORY
set -eo pipefail

if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release delete "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --yes --cleanup-tag
  echo "已删除旧 Release"
else
  echo "无旧 Release 需要删除（首次构建）"
fi

# dev 是 pre-release（不污染稳定 latest）；main 是正式版。
prerelease=""
if [ "$CHANNEL" = "dev" ]; then prerelease="--prerelease"; fi
if [ "$CHANNEL" = "main" ]; then
  TITLE="DSH master"
  NOTES="DSH 稳定版（dsh-master-latest）：由 main 分支发出，上游提交钉在 portable/upstream.pin（可复现）。历史会话与新版功能均正常，推荐使用。想尝鲜切到 dev 通道（dsh-dev-latest，每日跟随上游）。"
else
  TITLE="DSH dev"
  NOTES="DSH dev 通道（dsh-dev-latest，pre-release）：每日自动构建上游最新代码 + 本地兼容性修复。首次以本版本启动时会自动把本地 v2/v3 会话迁移到 v4（一次性、可回滚）。稳定版请用 dsh-master-latest。"
fi
# 上游自己的版本号（root package.json 的 version）。**只给人看，绝不参与任何 semver 判定** ——
# 插件兼容门禁用的是包内 app-boot 的 version（portable/plugin-refresh.mjs:253-272），必须保持上游原样。
# 它在这里的价值是解释一个反直觉的现象：上游把稳定线同步回 master 用的是 merge，所以 dev 包可能
# 写着 0.2.2-alpha.2 却已包含 0.2.1-rc.5 的全部修复（实测 2026-10-29：两者都是 master 头的祖先）。
# 读不到就写 unknown —— 这一行不是判定依据，不值得为它让发版失败。
upstream_version="$(gh api "repos/deepseek-ai/deepseek-harness/contents/package.json?ref=$UPSTREAM_SHA" \
  --jq '.content' 2>/dev/null | base64 -d 2>/dev/null | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -1 || true)"
if [ -z "$upstream_version" ]; then upstream_version="unknown"; fi
echo "上游版本号 = $upstream_version"

# 机器可读的尾部：check 的跳过判定（ci/resolve-target.sh）读的就是 `upstream:` 与 `glue:` 两行，别再改格式。
NOTES="$(printf '%s\n\nupstream: %s\nglue: %s\nversion: %s\nchannel: %s\nbuilt-from: %s' "$NOTES" "$UPSTREAM_SHA" "$GLUE" "$upstream_version" "$CHANNEL" "$GLUE_SHA")"
# shellcheck disable=SC2086 # $prerelease 为空时必须消失，不能变成空参数
gh release create "$RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --title "$TITLE ($(date +%Y%m%d))" \
  --notes "$NOTES" \
  $prerelease \
  artifacts/*/*.zip
