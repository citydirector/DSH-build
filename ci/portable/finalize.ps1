# portable job（冒烟之后）：校验 bundle、修默认 profile、打 zip。输入（env）：SHORT_SHA
$ErrorActionPreference = 'Stop'
$profileDir = 'portable\data\profiles\web'
$profileJson = "$profileDir\package.json"

# 1. 校验「随包的应用撑得住它对外宣称的 bundle」。插件面板的分区靠两个硬编码名单（客户端
#    BUILTIN_PROFILE_BUNDLES / 宿主 OPTIONAL_BUNDLES），而 profile 选中的 bundle 未必是依赖 ——
#    只靠 app/node_modules 兜着；兜不住就是启动时行加载失败，而且只有用户机器上看得见。
#    名单从已部署的包里解析，不写死；解析不出来就退出码 2。默认 profile 是 boot 时生成的，正好当被测 profile。
$cbArgs = @('_build_repo\portable\check-bundles.mjs', 'portable\app\node_modules')
if (Test-Path $profileJson) { $cbArgs += @('--profile', $profileDir) } else { Write-Host "默认 profile 不存在，只校验随包名单" }
node @cbArgs
if ($LASTEXITCODE -ne 0) { throw "check-bundles 失败：随包撑不住某个 bundle（见上面的清单）" }

# 2. 默认 profile 由 boot 生成（无 version），而 package-inventory 插件要求每个活跃条目所属包的
#    package.json 带非空 name+version；本地相对路径插件会解析到 profile 自己，缺 version 即抛错。
if (Test-Path $profileJson) {
  node -e "const fs=require('fs');const p='portable/data/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));if(!j.version){j.version='0.1.0';fs.writeFileSync(p,JSON.stringify(j,null,2))}else{console.log('already has version '+j.version)}"
  if ($LASTEXITCODE -ne 0) { throw "默认 profile 注入 version 失败" }
} else { Write-Host "默认 profile 不存在，跳过 version 注入" }

# 3. 冒烟测试会留下 data/（含会话 grant、匿名 id、workspace 状态），不进发行包。
#    _smoke*.log 在 portable/ 之外，无需额外排除。
Remove-Item portable\data -Recurse -Force -ErrorAction SilentlyContinue
Compress-Archive -Path portable\* -DestinationPath "dsh-portable-win64-$env:SHORT_SHA.zip"
