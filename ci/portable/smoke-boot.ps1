# portable job：用便携 node 真正 boot（web 模式）完整插件树 —— import 全部插件，比 --help /
# --dump-default-config 更严格，能捕获 deploy 漏掉的 registry 依赖（如 cordis-plugin-hmr 的
# @babel/code-frame）。失败时把 stdout+stderr 合并进 _smoke.log，供 artifact 上传与失败通知读取。
$ErrorActionPreference = 'Stop'

# 随包 node.exe 必须就是 align-node 选定的那条主线、且不低于上游 engines.node 的下限：
# stamp.ps1 拷的是 PATH 上的 node，这里用包里那份亲自复核一次，防止拷错 / setup-node 没按预期装。
$bundledNode = (& portable\node\node.exe --version)
& portable\node\node.exe _build_repo\ci\align-node.mjs --assert
if ($LASTEXITCODE -ne 0) { throw "随包 node.exe $bundledNode 不满足上游 engines.node（align-node --assert 退出码 $LASTEXITCODE）" }

$env:DSH_HOME = Join-Path (Get-Location) "portable\data"
$env:PATH = (Join-Path (Get-Location) "portable\node") + ";" + $env:PATH
$outLog = "_smoke.log"
$errLog = "_smoke.err.log"
$p = Start-Process -FilePath "portable\node\node.exe" -ArgumentList "portable\app\lib\bin.js","web" -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
$ok = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
  Start-Sleep -Seconds 1
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ar = $c.BeginConnect("127.0.0.1", 3080, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne(800)) { $c.EndConnect($ar); $c.Close(); $ok = $true; break }
    $c.Close()
  } catch {}
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
if (-not $ok) {
  $merged = @()
  if (Test-Path $outLog) { $merged += Get-Content $outLog }
  if (Test-Path $errLog) { $merged += Get-Content $errLog }
  $merged | Out-File -FilePath $outLog -Encoding utf8
  throw "dsh 冒烟测试失败（未能成功 boot，疑似缺依赖）"
}
Write-Host "dsh 成功 boot（3080 监听）"

# 插件管理冒烟：随包 pnpm 经 dsh-plugin-cli.mjs 离线装一个本地插件，再让 plugin-refresh.mjs
# 用 app 自己的 semver / app-boot 版本出一份计划 —— 验证 `dsh plugin` 与 update.exe 的插件刷新在真实包里可用。
$pluginHome = Join-Path $env:RUNNER_TEMP 'dsh-plugin-smoke'
Remove-Item $pluginHome -Recurse -Force -ErrorAction SilentlyContinue
$pluginSrc = Join-Path $pluginHome 'src\dsh-smoke-plugin'
New-Item -ItemType Directory -Force $pluginSrc | Out-Null
Set-Content (Join-Path $pluginSrc 'package.json') '{"name":"dsh-smoke-plugin","version":"1.0.0","type":"module","main":"index.js","peerDependencies":{"@deepseek-ai/dsh":">=0.0.0-0"}}' -Encoding ascii
Set-Content (Join-Path $pluginSrc 'index.js') 'export const name = "dsh-smoke-plugin"; export function apply() {}' -Encoding ascii
$env:DSH_HOME = Join-Path $pluginHome 'home'
$env:npm_config_store_dir = Join-Path $pluginHome 'store'
& portable\node\node.exe portable\app\dsh-plugin-cli.mjs plugin --profile smoke add "file:$pluginSrc" --offline --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）—— 随包 pnpm 未接通" }
if (-not (Test-Path (Join-Path $env:DSH_HOME 'profiles\smoke\node_modules\dsh-smoke-plugin\package.json'))) { throw 'dsh plugin add 未把插件装进 profile' }
$plan = Join-Path $pluginHome 'plan.json'
& portable\node\node.exe portable\app\plugin-refresh.mjs check --home $env:DSH_HOME --runtime portable\app --out $plan
if ($LASTEXITCODE -ne 0) { throw "plugin-refresh check 失败（退出码 $LASTEXITCODE）" }
$status = (Get-Content $plan -Raw | ConvertFrom-Json).profiles[0].plugins[0].status
if ($status -ne 'ok') { throw "plugin-refresh 计划异常：dsh-smoke-plugin 状态为 $status" }
Write-Host '插件管理冒烟通过（dsh plugin add + plugin-refresh check）'
