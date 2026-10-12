# 用 .NET Framework 4.8 自带的 csc 编译启动器 / 更新器。
# 用法：compile-exes.ps1 -OutDir <dir> [-Launcher]
#   便携版：-OutDir portable -Launcher（dsh.exe + update.exe）
#   桌面端：-OutDir _build_repo\portable（只要 update.exe，由 build-desktop.mjs 放进包里）
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$Launcher
)
$ErrorActionPreference = 'Stop'
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$src = Join-Path $PSScriptRoot '..\portable'
if ($Launcher) {
  & $csc /nologo /target:exe "/out:$OutDir\dsh.exe" `
    /r:System.IO.Compression.FileSystem.dll `
    "$src\dsh-launcher.cs"
  if (-not (Test-Path "$OutDir\dsh.exe")) { throw "dsh.exe 编译失败" }
}
& $csc /nologo /target:exe "/out:$OutDir\update.exe" `
  /r:System.IO.Compression.FileSystem.dll `
  /r:System.IO.Compression.dll `
  "$src\dsh-updater.cs"
if (-not (Test-Path "$OutDir\update.exe")) { throw "update.exe 编译失败" }
