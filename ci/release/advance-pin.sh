#!/usr/bin/env bash
# release job（仅 dev 通道）：发布成功后才推进 pin，让 pin 永远等于「dev 通道当前产物对应的上游提交」。
# 跳过判定不看 pin，看 Release body 的 `upstream:`/`glue:` 两行；pin 不计入胶水指纹，不会误触发重建。
# 用 GITHUB_TOKEN 推送不会再触发 workflow，不会自我循环。
# 输入（env）：UPSTREAM_SHA, SHORT_SHA；工作目录 = 本仓库在 github.ref_name 上的检出
set -eo pipefail

current="$(cat portable/upstream.pin)"
if [ "$current" = "$UPSTREAM_SHA" ]; then
  echo "pin 已指向本次构建的上游提交，无需提交"
  exit 0
fi

# pin 只许前进。pin 是 main 通道的可复现基线（ci/resolve-target.sh 里 main 分支就按它取上游提交），
# dev 一旦在回退窗口里构建成功，无条件写入就会把稳定通道的基线一起拖回去。
# 正常情况 resolve-target.sh 的方向护栏已经拦住了回退，这里是第二道：手动触发（可越过护栏）之后
# 仍然守住 pin。工作目录是本仓库的检出，没有上游的提交树，所以用 API 判祖先关系。
#   git merge-base --is-ancestor A B  ⟺  compare(A...B).status ∈ {ahead, identical}
ancestry="$(gh api "repos/deepseek-ai/deepseek-harness/compare/$current...$UPSTREAM_SHA" --jq '.status' 2>/dev/null || true)"
case "$ancestry" in
  ahead | identical)
    echo "🧭 pin 前进：$current → $UPSTREAM_SHA"
    ;;
  behind | diverged)
    echo "::warning::上游回退，pin 保持 ${current:0:7} 不动（本次构建的上游 $UPSTREAM_SHA 不是它的后代，compare = $ancestry）"
    echo "            稳定通道继续钉在 $current。确认要改基线请手动编辑 portable/upstream.pin。"
    exit 0
    ;;
  *)
    echo "::warning::无法判定 pin 方向（compare 返回 '$ancestry'），pin 保持不变"
    exit 0
    ;;
esac

echo "$UPSTREAM_SHA" > portable/upstream.pin
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add portable/upstream.pin
git commit -m "chore(dev): track upstream $SHORT_SHA"
git push
