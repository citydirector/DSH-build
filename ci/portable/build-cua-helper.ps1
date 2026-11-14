# build-cua-helper.ps1 —— 在 Windows CI 上构建 win-x64 Computer Use helper，并打包成标准 payload zip。
#
# 用法：pwsh ci/portable/build-cua-helper.ps1 -Root <upstream-root> -Commit <40位sha> [-Out dist/cua-helper-win-x64] [-Architecture x64]
#
# Why：上游 cua-windows 在安装态只 access() 已有 helper，不编译（native-build.ts 的
# prepareNativeExecutable）。所以 helper 必须在构建期产好、随三份产物一起发；用户机器没有
# .NET SDK。这里只做编排：真正的 restore/publish/元数据逻辑在 portable/cua-helper.mjs，
# 本脚本负责先打 B 的 ui-locate 原生补丁、取补丁后的 native 源码摘要、把 payload 压成 zip
# 并验证 zip 根条目（与上游 cua-helper-package-windows.yml 同形），供 artifact 上传与下游校验。
#
# 为什么不把 dotnet 写在这里：node 侧 publish 同时负责生成 cua-helper.json、自校验、拒绝
# 非 .NET 10 / 缺件 / 摘要不符；两处写同一份逻辑早晚会漂。
#
# 关闭开关：无。helper 是新 CUA 链的必需产物，缺失必须让构建失败（见 AGENTS.md 的
# 「补丁与产物必须大声失败」）。若确需临时跳过，只能改 workflow 而不改本脚本。
#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Commit,
  [string]$Out = 'dist/cua-helper-win-x64',
  [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$outPath = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))

if ($Commit -notmatch '^[0-9a-f]{40}$') { throw "Commit 必须是 40 位小写十六进制，实际：$Commit" }

# 原生补丁必须先于 dotnet publish：B 的桥接改了 entry/{Input,DesktopExecutor,Win32}.cs，
# 只补 TS 不补原生会得到「协议里有新参数、二进制不认识」的 helper。缺失即失败，不跳过。
$bridgePath = Join-Path $repoRoot 'portable/patch-cua-ui-locate-bridge.mjs'
if (-not (Test-Path -LiteralPath $bridgePath)) {
  throw "缺少 $bridgePath —— ui-locate 桥接补丁未随仓，helper 不能构建（否则会发布旧二进制）"
}
Write-Output '== cua-helper: apply ui-locate native bridge before publish'
& node $bridgePath $rootPath
if ($LASTEXITCODE -ne 0) { throw "patch-cua-ui-locate-bridge 失败（退出码 $LASTEXITCODE）" }

# 打完补丁再取摘要：它记录的是「实际被编译的原生源码树」，上游同 SHA 未打补丁的 helper 会得到不同值。
$digestLines = @(& node $bridgePath $rootPath --digest)
if ($LASTEXITCODE -ne 0) { throw "patch-cua-ui-locate-bridge --digest 失败（退出码 $LASTEXITCODE）" }
# 摘要是**一行 JSON**，但它不一定在最后：桥接脚本的补丁日志可能排在它后面，所以按内容找，不按位置取。
$digestJson = @($digestLines | Where-Object { $_ -match '"kind"\s*:\s*"cua-helper-native-source"' })
if ($digestJson.Count -ne 1) {
  throw "桥接脚本应输出且只输出一行原生源码摘要，实际 $($digestJson.Count) 行（最后一行：$($digestLines[-1])）"
}
$digestJson = $digestJson[0]
$nativeSourcePath = Join-Path (Split-Path -Parent $outPath) 'cua-native-source.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nativeSourcePath) | Out-Null
Set-Content -LiteralPath $nativeSourcePath -Value $digestJson -Encoding utf8NoBOM

Write-Output "== cua-helper: publish $Architecture from $rootPath (commit $Commit)"
& node (Join-Path $repoRoot 'portable/cua-helper.mjs') publish --root $rootPath --out $outPath --commit $Commit --architecture $Architecture --native-source-file $nativeSourcePath
if ($LASTEXITCODE -ne 0) { throw "cua-helper publish 失败（退出码 $LASTEXITCODE）" }

$manifestPath = Join-Path $outPath 'cua-helper.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "publish 之后仍没有 $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$zipPath = "$outPath.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $outPath '*') -DestinationPath $zipPath -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = @($zip.Entries | ForEach-Object { $_.FullName })
} finally {
  $zip.Dispose()
}
foreach ($required in @('cua-helper.json', 'dsh-cua-windows.exe', 'dsh-cua-windows.dll', 'dsh-cua-windows.deps.json', 'dsh-cua-windows.runtimeconfig.json')) {
  if ($names -notcontains $required) { throw "helper zip 根目录缺少 $required（安装态会照样起不来）" }
}
if ($names -notcontains $manifest.executable) { throw "helper zip 缺少清单声明的 executable $($manifest.executable)" }

Write-Output "cua-helper: zip=$zipPath architecture=$($manifest.architecture) files=$(@($manifest.files.PSObject.Properties).Count) buildKey=$($manifest.buildKey)"

if ($env:GITHUB_OUTPUT) {
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "zip=$zipPath"
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "directory=$outPath"
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "build_key=$($manifest.buildKey)"
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "artifact_name=cua-helper-windows-$($manifest.architecture)-$($manifest.buildKey.Substring(0, 12))"
}
