#!/usr/bin/env bash
# release job（仅 dev 通道）：发布成功后才推进 pin，让 pin 永远等于「dev 通道当前产物对应的上游提交」。
# 跳过判定不看 pin，看 Release body 的 `upstream:`/`glue:` 两行；pin 不计入胶水指纹，不会误触发重建。
# 用 GITHUB_TOKEN 推送不会再触发 workflow，不会自我循环。
# 输入（env）：UPSTREAM_SHA, SHORT_SHA；工作目录 = 本仓库在 github.ref_name 上的检出
set -eo pipefail

if [ "$(cat portable/upstream.pin)" = "$UPSTREAM_SHA" ]; then
  echo "pin 已指向本次构建的上游提交，无需提交"
  exit 0
fi
echo "$UPSTREAM_SHA" > portable/upstream.pin
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add portable/upstream.pin
git commit -m "chore(dev): track upstream $SHORT_SHA"
git push
