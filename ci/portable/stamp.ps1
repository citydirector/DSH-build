# portable job：放 node 运行时 + 写 VERSION / GLUE。输入（env）：UPSTREAM_SHA, GLUE
# GLUE = 本仓库内容（除 pin 之外）的指纹。VERSION 只记上游提交号，于是"上游没动、胶水改了"的更新
# （补丁脚本、启动器、更新器）在 update.exe 眼里不可见；GLUE 让 update.exe 也认得出这种更新。
$ErrorActionPreference = 'Stop'
# 只取自包含的 node.exe；npm/corepack 等开发工具不需要
$nodeExe = (Get-Command node).Source
New-Item -ItemType Directory -Force portable\node | Out-Null
Copy-Item $nodeExe portable\node\node.exe -Force

Set-Content -Path portable\VERSION -Value $env:UPSTREAM_SHA -NoNewline
Set-Content -Path portable\GLUE -Value $env:GLUE -NoNewline
if (-not (Get-Content portable\VERSION)) { throw "VERSION 未写入" }
if (-not (Get-Content portable\GLUE)) { throw "GLUE 未写入" }
"VERSION = $(Get-Content portable\VERSION)"
"GLUE    = $(Get-Content portable\GLUE)"
