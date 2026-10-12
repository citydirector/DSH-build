# portable job：断言补进来的东西真在位、且声明进了安装清单。
# patch-dep 找不到种子时只 warn 不报错（"缺失于 root，跳过"），于是这类洞会静默复发 ——
# @babel/code-frame、@standard-schema/spec 都是这么漏过去的。文件在位还不够：这些包必须
# **出现在安装清单里**，否则 profile 的插件行会被判未安装（dsh-app-boot 只认清单的
# dependencies ∪ peerDependencies），行消失时 stderr 只有 "failed to import"，GUI 应用看不到。
$ErrorActionPreference = 'Stop'
$manifest = Get-Content 'portable\app\package.json' -Raw | ConvertFrom-Json
$declared = @($manifest.dependencies.PSObject.Properties.Name)
function Assert-Declared([string]$family, [string[]]$names) {
  $undeclared = @($names | Where-Object { $declared -notcontains $_ })
  if ($undeclared.Count -gt 0) { throw ("[$family] portable\app\package.json 未声明：" + ($undeclared -join ', ') + " —— profile 插件行会被判未安装") }
  Write-Host ("[$family] 已声明：" + ($names -join ', '))
}

# --- computer-use：缺了 Cua Driver SDK，官方 computer-use 提供方会在激活时抛「原生模块导入失败」。
# @trycua/cua-driver 是 patch-peers 拷进来的 workspace 包缺的 registry 依赖：补上它，computer use 就
# 随包发行、版本与 app 同生共死（提供方的 peer 是精确版本，profile 单装的旧副本会被判不兼容）。
$must = @(
  'app\node_modules\@trycua\cua-driver\package.json',
  'app\node_modules\@trycua\cua-driver-win32-x64-msvc',
  'app\node_modules\@ubjs\core',
  'app\node_modules\@ubjs\node'
)
$missing = @($must | Where-Object { -not (Test-Path "portable\$_") })
if ($missing.Count -gt 0) { throw ("Cua Driver SDK 没补进来：" + ($missing -join ', ')) }
$sdk = Get-Item 'portable\app\node_modules\@trycua\cua-driver\package.json'
$native = Get-ChildItem 'portable\app\node_modules\@trycua\cua-driver-win32-x64-msvc' -Recurse -Filter '*.node' -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ("cua-driver 已随包（package.json " + $sdk.Length + " 字节）；原生二进制：" + $(if ($native) { $native.Name + " / " + [math]::Round($native.Length / 1MB, 1) + " MB" } else { '(未找到 .node)' }))
Assert-Declared 'computer-use' @('@trycua/cua-driver', '@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native')

# --- browser-use：纯 JS 那一族，同样要包在位 + 清单里有名。
$browser = @(
  'chrome-devtools-mcp',
  '@deepseek-ai/dsh-browser-use',
  '@deepseek-ai/dsh-experimental-browser-use-runtime',
  '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'
)
$missing = @($browser | Where-Object { -not (Test-Path ("portable\app\node_modules\" + $_ + "\package.json")) })
if ($missing.Count -gt 0) { throw ("browser-use 没补进来：" + ($missing -join ', ')) }
Assert-Declared 'browser-use' $browser
