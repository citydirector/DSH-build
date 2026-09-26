// build-migrator.mjs <upstream-root> <out-file>
//
// 把上游的 scripts/migrate-sessions-to-v4.ts 打成随包分发的单文件 ESM：上游只在写打开（resume）
// 时才升级旧代际会话，便携版升到 v4 后必须一次性补迁移；而上游自带命令假设自己跑在 git 工作树里
// 且按源码相对路径 import，这两点在便携包里都不成立，故按三处差异适配：
//   1. 相对 import（../packages/.../format.ts 等）→ esbuild 内联（这些源码不在发布包里，只能构建期取）；
//   2. 裸 import（@deepseek-ai/…）→ 保持 external，运行时从 app/node_modules 解析（迁移逻辑仍用上游自己的机器）；
//   3. node:child_process 的 `git rev-parse HEAD` → 换成返回 DSH_BUILD_COMMIT 的桩；否则真实调用抛异常被
//      上游兜底 catch 吃掉，结果是「一个会话都没迁移却退出码 1」。
//
// 用法（windows job 里，install 之后、strip 之前）：
//   node _build_repo\portable\build-migrator.mjs . portable\app\migrate-sessions-v4.mjs
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? '.')
const out = resolve(process.argv[3] ?? join(root, 'portable', 'app', 'migrate-sessions-v4.mjs'))
const entry = join(root, 'scripts', 'migrate-sessions-to-v4.ts')

if (!existsSync(entry)) {
  console.error(`[migrator] 上游脚本不存在: ${entry}`)
  process.exit(2)
}

// esbuild 不是上游的直接依赖（由 tsx / vitepress 带进来）。hoisted 布局下通常在根
// node_modules，但为免布局变化，按「直接解析 → 根目录 → 已知嵌套位置 → .pnpm 扫描」兜底。
async function loadEsbuild() {
  const tried = []
  const require = createRequire(join(root, 'package.json'))
  try {
    return await import(pathToFileURL(require.resolve('esbuild')).href)
  } catch (error) {
    tried.push(`require.resolve('esbuild'): ${error.message}`)
  }
  const direct = [
    join(root, 'node_modules', 'esbuild', 'lib', 'main.js'),
    join(root, 'node_modules', 'tsx', 'node_modules', 'esbuild', 'lib', 'main.js'),
  ]
  const pnpmStore = join(root, 'node_modules', '.pnpm')
  if (existsSync(pnpmStore)) {
    for (const name of readdirSync(pnpmStore).sort()) {
      if (name === 'esbuild' || name.startsWith('esbuild@')) {
        direct.push(join(pnpmStore, name, 'node_modules', 'esbuild', 'lib', 'main.js'))
      }
    }
  }
  for (const candidate of direct) {
    if (!existsSync(candidate)) {
      tried.push(`${candidate}: 不存在`)
      continue
    }
    try {
      return await import(pathToFileURL(candidate).href)
    } catch (error) {
      tried.push(`${candidate}: ${error.message}`)
    }
  }
  console.error('[migrator] 找不到可用的 esbuild：')
  for (const line of tried) console.error(`  - ${line}`)
  process.exit(2)
}

// 只替换子进程调用，其余 node: 内置模块照常 external。
const stubChildProcess = {
  name: 'stub-child-process',
  setup(build) {
    build.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: 'child-process-stub', namespace: 'dsh-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'dsh-stub' }, () => ({
      loader: 'js',
      contents: [
        '// DSH-build: 便携包不在 git 工作树里，git HEAD 探测没有意义，改为读取构建期注入的提交号。',
        'export function execFileSync() { return `${process.env.DSH_BUILD_COMMIT ?? ""}\\n` }',
        'export function execSync() { return execFileSync() }',
        'export function spawnSync() { return { status: 1, stdout: "", stderr: "" } }',
        '',
      ].join('\n'),
    }))
  },
}

const esbuild = await loadEsbuild()

// 上游脚本用 `error instanceof JsonlGenerationSourceChangedError` 决定「迁移途中源代际变了，
// 把这次推迟到串行重试」。这个类来自 session-persistence-jsonl 的 src/generation.ts：我们把它
// 内联进 bundle 之后，它和已部署 lib 真正抛出的那个类不是同一个对象，instanceof 恒为假 ——
// 上游的推迟/重试保护会静默失效，本该被推迟的会话被记成 FAILED（实测：父子会话并发迁移时
// 首轮 2 个失败，重跑才补上）。这里把判断补成「instanceof 或同名」。上游若删改了这句，
// 构建期直接失败，避免 shim 悄悄失配。
const sourceChangedGuard = {
  name: 'source-changed-guard',
  setup(build) {
    const needle = 'error instanceof JsonlGenerationSourceChangedError'
    build.onLoad({ filter: /scripts[\\/]migrate-sessions-to-v4\.ts$/ }, async (args) => {
      const original = await readFile(args.path, 'utf8')
      if (!original.includes(needle)) {
        throw new Error(`[migrator] 上游脚本里找不到 "${needle}"；推迟/重试保护可能已改动，请核对本 shim`)
      }
      const contents = original.replace(
        needle,
        // 外层括号是必须的：原句是 `!retry && <needle>`，不加括号会变成
        // `(!retry && instanceof) || 同名` —— 重试轮会再次走「推迟」分支，
        // 而推迟队列只跑一轮，结果是这些会话被静默跳过、汇总里既不 failed 也不 converted。
        `(${needle} || (error as { name?: string } | undefined)?.name === 'JsonlGenerationSourceChangedError')`,
      )
      return { contents, loader: 'ts', resolveDir: args.resolveDir }
    })
  },
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // 便携包随包的是 node.exe 24（见 workflow 的 Copy node runtime）。目标定在 24 才能用
  // import.meta.dirname/filename —— 上游脚本的 main-guard 依赖它们。
  target: 'node24',
  // packages:'external' + 明确禁止读 tsconfig：上游根 tsconfig.json 把 @deepseek-ai/* 用
  // `paths` 映射到 packages/** 源码，esbuild 会先按 paths 把它们解析成文件路径，于是
  // packages:'external' 失效 —— 结果是把大半个 monorepo（session/llm/...）内联进产物，
  // 运行时 import.meta.url 指向便携包里的这个文件，`createRequire(...)('../package.json')`
  // 之类的自引用全部崩掉。tsconfigRaw: '{}' 让 esbuild 不读磁盘上的 tsconfig，裸包名
  // 才能原样留到运行时、从 app/node_modules 解析。
  tsconfigRaw: '{}',
  packages: 'external',
  external: ['@deepseek-ai/*'],
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'info',
  banner: {
    js: '// GENERATED by DSH-build portable/build-migrator.mjs from upstream scripts/migrate-sessions-to-v4.ts — do not edit.',
  },
  plugins: [stubChildProcess, sourceChangedGuard],
})

const size = statSync(out).size
console.log(`[migrator] ${out} (${(size / 1024).toFixed(1)} KiB) ← ${entry}`)
