#!/usr/bin/env bash
# check job：解析通道 + 目标上游提交 + 胶水指纹 + 跳过判定，写进 $GITHUB_OUTPUT。
# 工作目录必须是上游 deepseek-harness 的 master 检出（dev 通道读它的 HEAD）。
# 输入（env）：REF_NAME, EVENT_NAME, INPUT_CHANNEL, BUILD_SHA（本仓库 github.sha）, GH_TOKEN, GITHUB_REPOSITORY
set -eo pipefail

channel=dev
tag=dsh-dev-latest
if [ "$REF_NAME" = "main" ]; then channel=main; tag=dsh-master-latest; fi
# 手动触发可用 inputs.channel 覆盖分支推导（auto 保持上面的结果）
if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  case "$INPUT_CHANNEL" in
    main) channel=main; tag=dsh-master-latest ;;
    dev)  channel=dev;  tag=dsh-dev-latest ;;
  esac
fi
echo "channel=$channel" >> "$GITHUB_OUTPUT"
echo "release_tag=$tag" >> "$GITHUB_OUTPUT"

if [ "$channel" = "main" ]; then
  # 稳定通道：钉在 portable/upstream.pin 上（按 BUILD_SHA 用 API 读，与本次触发的提交严格一致）
  sha="$(gh api "repos/$GITHUB_REPOSITORY/contents/portable/upstream.pin?ref=$BUILD_SHA" \
         --jq '.content' | base64 -d | tr -d '[:space:]')"
  if ! printf '%s' "$sha" | grep -qE '^[0-9a-f]{40}$'; then
    echo "::error::portable/upstream.pin 不是 40 位 commit sha：'$sha'"
    exit 1
  fi
  if ! gh api "repos/deepseek-ai/deepseek-harness/commits/$sha" >/dev/null 2>&1; then
    echo "::error::upstream.pin 指向的提交在上游不存在：$sha"
    exit 1
  fi
  echo "🎯 main 通道：目标 = pin $sha"
else
  # dev 通道：跟随上游 master 头
  sha="$(git rev-parse HEAD)"
  echo "🎯 dev 通道：目标 = 上游 master 头 $sha"
fi
echo "sha=$sha" >> "$GITHUB_OUTPUT"
echo "short_sha=${sha:0:7}" >> "$GITHUB_OUTPUT"

# 胶水指纹：本仓库内容里**除 pin 之外**的 blob 摘要。
# 跳过判定必须同时看它 —— 上游提交没动、但胶水改了（补丁脚本、workflow、启动器源码），
# 产物是会变的。只看上游的话，这类改动静默地出不了货（实测踩到过：晋升 PR 合进 main
# 却没动 pin，于是整轮直接跳过，新胶水一直没进稳定版）。
# 排除 pin 是关键：dev 每次发布后都会推进 pin，那不改变产物、不该触发重建。
glue="$(gh api "repos/$GITHUB_REPOSITORY/git/trees/$BUILD_SHA?recursive=1" \
        --jq '[.tree[] | select(.path != "portable/upstream.pin") | "\(.path):\(.sha)"] | sort | join("\n")' \
        | sha256sum | cut -c1-16)"
echo "glue=$glue" >> "$GITHUB_OUTPUT"
echo "🧬 胶水指纹 = $glue"

# 跳过判定：手动 dispatch 一律构建；schedule / push 在「目标上游提交相同 **且** 胶水指纹相同」
# 时跳过。两个来源都从 Release body 机器可读行读（旧格式缺行 → 不跳过，迁移期安全）。
if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "🔨 手动触发：直接构建"
  exit 0
fi
body="$(curl -sf -H "Authorization: Bearer $GH_TOKEN" \
        "https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$tag" | jq -r .body || true)"
last="$(printf '%s' "$body" | sed -n 's/^upstream: \([0-9a-f]\{40\}\).*/\1/p')"
last_glue="$(printf '%s' "$body" | sed -n 's/^glue: \([0-9a-f]\{16\}\).*/\1/p')"
if [ -n "$last" ] && [ -n "$last_glue" ] && [ "$last" = "$sha" ] && [ "$last_glue" = "$glue" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "✅ $tag 已经是这个上游提交 + 这套胶水（$sha / $glue），跳过"
else
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "📦 $tag: 上游 ${last:-<无记录>} → $sha ；胶水 ${last_glue:-<无记录>} → $glue"
fi
