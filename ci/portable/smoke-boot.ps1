# portable job：用便携 node 真正 boot（web 模式）完整插件树 —— import 全部插件，比 --help /
# --dump-default-config 更严格，能捕获 deploy 漏掉的 registry 依赖（如 cordis-plugin-hmr 的
# @babel/code-frame）。失败时把 stdout+stderr 合并进 _smoke.log，供 artifact 上传与失败通知读取。
$ErrorActionPreference = 'Stop'
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
