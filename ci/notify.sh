#!/usr/bin/env bash
# Server 酱推送。用法：notify.sh success | failure
# 输入（env）：SC3_UID, SC3_SENDKEY, SHORT_SHA, RELEASE_TAG（success）, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID
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
  *) echo "用法: notify.sh success|failure" >&2; exit 2 ;;
esac
curl -sf -X POST -H "Content-Type: application/json" --data-binary @/tmp/body.json \
  "https://$SC3_UID.push.ft07.com/send/$SC3_SENDKEY.send" || true
