# portable job：给已部署的上游产物打本地修复（幂等、可自愈；上游修复后自动跳过）。
# 1. patch-native-code：hasIntrinsicConstructor 的 toString 精确比较在真实浏览器输出带换行，导致全对象
#    被判非 lossless JSON、消息无法渲染 → 归一化空白后比较（dsh-workflow-ptc 里的内联字面量按上下文多
#    转义一层）；session v2→v3 迁移白名单补历史 kind "instruction-hint"（v4 批量迁移 0 拒绝的前提）。
# 2. patch-session-lock：见脚本头注释。
# 3. patch-tool-schema：MCP 工具 JSON Schema 里的非字符串 enum（如 cua driver 的 verify_state
#    exists: [true]）会让只认字符串枚举的路由把整条请求打回 400 → 摘掉。
# 输入（env）：UPSTREAM_SHA（迁移器读 DSH_BUILD_COMMIT）
$ErrorActionPreference = 'Stop'
foreach ($script in @('patch-native-code', 'patch-session-lock', 'patch-tool-schema')) {
  node "_build_repo\portable\$script.mjs" portable\app\node_modules\@deepseek-ai
  if ($LASTEXITCODE -ne 0) { throw "$script 失败（退出码 $LASTEXITCODE）" }
}

# 迁移器装载校验：--help 之前会先解析全部 import，验证迁移器的 external 依赖（cordis / dsh-session /
# format-catalog / persistence-jsonl …）确实落在 app/node_modules 里 —— 否则它会在用户机器上启动即崩。
$env:DSH_BUILD_COMMIT = $env:UPSTREAM_SHA
node portable\app\migrate-sessions-v4.mjs --help
if ($LASTEXITCODE -ne 0) { throw "migrate-sessions-v4.mjs 装载失败（external 依赖未解析）" }
