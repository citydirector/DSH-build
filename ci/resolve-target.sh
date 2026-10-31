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
  echo "regressed=false" >> "$GITHUB_OUTPUT"
  echo "🔨 手动触发：直接构建"
  exit 0
fi
body="$(curl -sf -H "Authorization: Bearer $GH_TOKEN" \
        "https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$tag" | jq -r .body || true)"
last="$(printf '%s' "$body" | sed -n 's/^upstream: \([0-9a-f]\{40\}\).*/\1/p')"
last_glue="$(printf '%s' "$body" | sed -n 's/^glue: \([0-9a-f]\{16\}\).*/\1/p')"

# ---- 版本方向护栏：已发布的那个提交必须是本次目标的祖先 ----
# 为什么需要：dev 跟随的是上游 master 头，而上游并行维护稳定线（0.2.1-rc）与特性线（0.2.2-alpha）。
# 把稳定线同步回 master 的那段时间里，master 头的版本号更低、内容更少 —— 实测
# 2026-10-29 13:01:28Z（rc.5 的 merge）到 13:14:24Z（merge master into sync 分支）之间，
# compare(dsh-v0.2.2-alpha.2 tag...dsh-v0.2.1-rc.5 tag) = diverged，ahead 4 / behind 2161。
# 这种提交一旦发出去，用户侧 update.exe 的判新只比 sha 与胶水是否**相等**（dsh-updater.cs:107-125，
# 没有任何方向语义），会把「回退」当成「更新」直接覆盖掉更新版本，插件那批精确 peer 钉版随之崩掉。
#
# 判据用祖先关系，不用版本号大小：上游融合两条线用的是 merge，融合之后 alpha.2 与 rc.5 **都是**
# master 头的祖先（实测 behind 0 / 0），于是「代码已含两边全部内容、只是版本号没涨」不会被误判成回退。
# compare(base...head).status 的语义：ahead = base 是 head 的祖先（前进）；behind / diverged = 回退。
# API 不可用时**失败而不放行** —— 宁可这次构建红，也不在方向不明的提交上发货。
regressed=false
if [ -n "$last" ] && [ "$last" != "$sha" ]; then
  ancestry="$(gh api "repos/deepseek-ai/deepseek-harness/compare/$last...$sha" --jq '.status' 2>/dev/null || true)"
  case "$ancestry" in
    ahead | identical)
      echo "🧭 上游方向：前进（已发布的 ${last:0:7} 是 ${sha:0:7} 的祖先）"
      ;;
    behind | diverged)
      regressed=true
      echo "⛔ 上游方向：回退（${last:0:7} 不是 ${sha:0:7} 的祖先，compare = $ancestry）"
      echo "   $tag 保持不动，等上游把这条线合回来再发。手动触发（workflow_dispatch）可越过此判定。"
      ;;
    *)
      # 走到这里只有两种可能：API 抖动，或已发布的那个提交在上游消失了（force push / 仓库迁移）。
      # 后者会让这个判定永久红，所以把恢复办法直接写进错误信息 —— 手动 dispatch 可越过本护栏。
      echo "::error::无法判定上游方向：compare($last...$sha) 返回 '$ancestry'。不在方向不明的提交上发版。"
      echo "   若是 API 抖动，重跑即可；若已发布的 $last 已在上游消失，用 workflow_dispatch 手动构建一次越过此判定。"
      exit 1
      ;;
  esac
fi
echo "regressed=$regressed" >> "$GITHUB_OUTPUT"

if [ "$regressed" = "true" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
elif [ -n "$last" ] && [ -n "$last_glue" ] && [ "$last" = "$sha" ] && [ "$last_glue" = "$glue" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "✅ $tag 已经是这个上游提交 + 这套胶水（$sha / $glue），跳过"
else
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "📦 $tag: 上游 ${last:-<无记录>} → $sha ；胶水 ${last_glue:-<无记录>} → $glue"
fi
