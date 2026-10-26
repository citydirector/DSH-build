# portable job：把 deploy 出来的运行时补齐成能跑的 app（工作目录 = 上游检出根，_build_repo = 本仓库）。
# 顺序有讲究，逐段说明：
$ErrorActionPreference = 'Stop'
function Invoke-Native([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what 失败（退出码 $LASTEXITCODE）" }
}

# 1. deploy 到 portable/app：把 @deepseek-ai/dsh 的包文件(lib/bin.js)放到 app 根，依赖(含 workspace 包)
#    装进 app/node_modules。不加 --prod（dsh 运行时插件在 devDependencies，靠 cordis 动态加载）；
#    不加 auto-install-peers=false。pnpm deploy 要求目标目录为空（ERR_PNPM_DEPLOY_DIR_NOT_EMPTY），
#    所以必须排在第一。allowUnusedPatches：deploy 只取 @deepseek-ai/dsh 子集，上游 pnpm-workspace.yaml
#    里的 macOS/desktop 补丁（@electron/osx-sign 等）不在子集内，否则报 ERR_PNPM_UNUSED_PATCH。
Invoke-Native 'pnpm deploy' {
  pnpm --pm-on-fail=ignore --filter @deepseek-ai/dsh deploy --legacy `
    --config.allowUnusedPatches=true `
    --config.node-linker=hoisted `
    --config.link-workspace-packages=true `
    portable/app
}

# 1b. pnpm 11.28 起，deploy 收尾会把「不在依赖树里、pnpm 也没有安装记录」的目录搬进
#     node_modules/.ignored（11.27 不做这件事）。deploy 只认 @deepseek-ai/dsh 那棵子树，
#     被判无关而搬走的 1170 个包里就有 @trycua/cua-driver、@ubjs/*、chrome-devtools-mcp、
#     @babel/code-frame、@standard-schema/spec —— 全是第 4、6 步要从根 node_modules 复制的东西。
#     搬走之后 patch-dep 只会"缺失于 root，跳过"，随包少了 Cua Driver SDK，直到 assert-shipped
#     才在最后一步报错。先把它们搬回去，根 node_modules 就回到 install 结束时的样子。
Invoke-Native 'restore-ignored' { node _build_repo\ci\portable\restore-ignored.mjs node_modules }

# 2. 会话代际迁移器：把上游 scripts/migrate-sessions-to-v4.ts 打成随包分发的单文件 ESM
#    （相对 import 内联，@deepseek-ai/* 保持 external 走 app/node_modules —— 迁移逻辑用的仍是上游
#    自己的机器）。dsh.exe 启动时跑一次，把本地 v2/v3 会话补迁移到 v4。
Invoke-Native 'build-migrator' { node _build_repo\portable\build-migrator.mjs . portable\app\migrate-sessions-v4.mjs }

# 3. deploy 会系统性漏掉 workspace 包之间的 peer 依赖（auto-install-peers 对 deploy 无效）。
#    patch-peers.mjs 遍历 workspace 全部 @deepseek-ai 包，把缺失的补齐（复制 lib/ + package.json）。
Invoke-Native 'patch-peers' { node _build_repo\portable\patch-peers.mjs . portable\app\node_modules\@deepseek-ai }

# 4. schemastery 依赖 @standard-schema/spec（registry 包，非 workspace），从 install 结果复制。
if (Test-Path "node_modules\@standard-schema\spec") {
  New-Item -ItemType Directory -Force "portable\app\node_modules\@standard-schema" | Out-Null
  Copy-Item "node_modules\@standard-schema\spec" "portable\app\node_modules\@standard-schema\spec" -Recurse -Force
}

# 5. 体积优化：删 sourcemap + build 工具（编译/lint/打包器/hooks，运行时绝不 import）。
#    typescript 被 dsh-typert-generator（编译期生成器）依赖，但运行时无 import，可删。
$nm = "portable\app\node_modules"
Get-ChildItem $nm -Recurse -Filter "*.map" -File | Remove-Item -Force -ErrorAction SilentlyContinue
$buildTools = @(
  'typescript','tsx','@esbuild','@rolldown','@oxlint','@oxlint-tsgolint',
  'lefthook','lefthook-windows-x64','lightningcss','lightningcss-win32-x64-msvc',
  '@babel','tsdown','vite','rollup','eslint','webpack','terser','prettier','oxc-resolver'
)
foreach ($t in $buildTools) {
  $p = Join-Path $nm $t
  if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}

# 6. deploy 漏掉 workspace 包的 registry 依赖（实测 cordis-plugin-hmr 的 @babel/code-frame 没带上，
#    HMR 插件运行时 import 它导致闪退）。patch-dep.mjs 从 root node_modules 递归补齐缺失依赖链，
#    并把种子**声明进目标清单**：dsh 判断"哪些包能被 profile 的插件行解析"看的是安装清单的
#    dependencies ∪ peerDependencies，只拷文件不声明 = 行被判未安装、整套插件静默消失。
#    computer-use（注册表 + 原生提供方）与 browser-use（注册表 / 运行时 / chrome-devtools-mcp 提供方）
#    的 workspace 包由 patch-peers 拷进来，列在这里是为了让清单里出现它们；chrome-devtools-mcp 是
#    提供方自己的 registry 依赖，得靠 patch-dep 从 root node_modules 带过来。
#    注意：step 5 删掉了 @babel，这里再把 @babel/code-frame 补回来（顺序与原 workflow 一致）。
Invoke-Native 'patch-dep' {
  node _build_repo\portable\patch-dep.mjs node_modules portable\app\node_modules `
    @babel/code-frame @deepseek-ai/schemastery @trycua/cua-driver @deepseek-ai/dsh-computer-use `
    @deepseek-ai/dsh-experimental-computer-use-cua-driver-native chrome-devtools-mcp `
    @deepseek-ai/dsh-browser-use @deepseek-ai/dsh-experimental-browser-use-runtime `
    @deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp
}

# 7. 插件随版本刷新：update.exe 在覆盖前后调用 plugin-refresh.mjs（见脚本头注释）；
#    dsh-plugin-cli.mjs 是 `dsh plugin ...` 的入口，把随包 pnpm 交给上游 CLI —— 便携版不在 PATH 上放
#    pnpm，直接跑 lib/bin.js 的插件命令一律 "pnpm was not found"。pnpm 取上游根 devDependency
#    （与桌面版 primary-runtime 里那份同版本），放 app\vendor 下：更新器只镜像 app/node，放别处不会随更新替换。
Copy-Item _build_repo\portable\plugin-refresh.mjs portable\app\plugin-refresh.mjs -Force
Copy-Item _build_repo\portable\dsh-plugin-cli.mjs portable\app\dsh-plugin-cli.mjs -Force
Invoke-Native 'vendor pnpm' {
  node -e "const fs=require('node:fs');fs.rmSync('portable/app/vendor/pnpm',{recursive:true,force:true});fs.cpSync(fs.realpathSync('node_modules/pnpm'),'portable/app/vendor/pnpm',{recursive:true,dereference:true})"
}
if (-not (Test-Path 'portable\app\vendor\pnpm\bin\pnpm.mjs')) { throw '随包 pnpm 缺少 bin\pnpm.mjs' }
