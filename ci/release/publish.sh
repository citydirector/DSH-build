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
# 机器可读的尾部：check 的跳过判定（ci/resolve-target.sh）读的就是 `upstream:` 与 `glue:` 两行，别再改格式。
NOTES="$(printf '%s\n\nupstream: %s\nglue: %s\nchannel: %s\nbuilt-from: %s' "$NOTES" "$UPSTREAM_SHA" "$GLUE" "$CHANNEL" "$GLUE_SHA")"
# shellcheck disable=SC2086 # $prerelease 为空时必须消失，不能变成空参数
gh release create "$RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --title "$TITLE ($(date +%Y%m%d))" \
  --notes "$NOTES" \
  $prerelease \
  artifacts/*/*.zip
