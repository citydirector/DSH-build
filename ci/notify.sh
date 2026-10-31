#!/usr/bin/env bash
# Server 酱推送。用法：notify.sh success | failure | regressed
# 输入（env）：SC3_UID, SC3_SENDKEY, SHORT_SHA, RELEASE_TAG（success / regressed）, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID
# 推送失败不影响构建结果（|| true）；secrets 没配时直接跳过。
set -eo pipefail

if [ -z "$SC3_UID" ] || [ -z "$SC3_SENDKEY" ]; then
  echo "SC3_UID / SC3_SENDKEY 未配置，跳过通知"
  exit 0
fi

case "$1" in
  success)
    url="https://github.com/$GITHUB_REPOSITORY/releases/tag/$RELEASE_TAG"
    jq -n --arg sha "$SHORT_SHA" --arg url "$url" \
      '{title:"DSH 构建成功",desp:("✅ DSH 构建完成\n\n提交: "+$sha+"\n\n下载: "+$url)}' \
      > /tmp/body.json
    ;;
  failure)
    # 主来源：失败步骤的真实日志（install/deploy 阶段失败时 _smoke.log 根本不存在）。
    err=$(gh run view "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --log-failed 2>/dev/null \
          | sed 's/\x1b\[[0-9;]*m//g' \
          | grep -aE "ERR_PNPM|ERR_|Cannot find|Cannot resolve|##\[error\]|throw|failed" \
          | tail -20 || true)
    # smoke 失败时 _smoke.log 里的错误更精确，覆盖上面的摘要
    if [ -s error-artifact/_smoke.log ]; then
      smoke=$(grep -iE "error|cannot find|cannot resolve|not found|throw|ERR_" error-artifact/_smoke.log | head -20 || true)
      if [ -n "$smoke" ]; then err="$smoke"; fi
    fi
    jq -n \
      --arg sha "$SHORT_SHA" \
      --arg err "$err" \
      --arg url "https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
      '{title:("DSH 构建失败 - "+$sha),desp:("❌ DSH 构建失败\n\n提交: "+$sha+"\n\n日志: "+$url+"\n\n错误摘要:\n```\n"+$err+"\n```")}' \
      > /tmp/body.json
    ;;
  regressed)
    # 方向护栏拦下了一次回退构建。这不是失败（流水线整体是绿的），但产物没更新 ——
    # 静默跳过会让人以为"今天上游没动"，所以单独推一条。
    # 已发布的那个提交自己从 Release body 读，不依赖调用方再传一遍变量。
    prev="$(curl -sf -H "Authorization: Bearer $GH_TOKEN" \
            "https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG" \
            | jq -r .body 2>/dev/null | sed -n 's/^upstream: \([0-9a-f]\{40\}\).*/\1/p' || true)"
    jq -n --arg sha "$SHORT_SHA" --arg prev "${prev:-<未记录>}" --arg tag "$RELEASE_TAG" \
      '{title:"DSH dev 跳过构建（上游回退）",desp:("⛔ 上游 master 头比已发布的更旧，本次不构建\n\n本次看到: "+$sha+"\n已发布  : "+$prev+"\n\n"+$tag+" 保持不动，等上游把这条线合回来再发。")}' \
      > /tmp/body.json
    ;;
  *) echo "用法: notify.sh success|failure|regressed" >&2; exit 2 ;;
esac
curl -sf -X POST -H "Content-Type: application/json" --data-binary @/tmp/body.json \
  "https://$SC3_UID.push.ft07.com/send/$SC3_SENDKEY.send" || true
