// patch-peers.mjs <workspace-root> <target-node_modules>
// deploy 会系统性漏掉 workspace 包之间的 peer 依赖（auto-install-peers 对 deploy 无效）。
// 本脚本遍历 workspace 全部 @deepseek-ai 包，把 target node_modules 里缺失的包补齐：
// 复制该包的 lib/ 目录 + package.json（build 产物已在 workspace 内生成）。
import { readdir, readFile, mkdir, stat, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const wsRoot = process.argv[2];
const target = process.argv[3]; // .../node_modules/@deepseek-ai

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name === 'package.json') yield p;
  }
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

const wsPkgs = new Map(); // name -> src dir
for (const base of ['vendor', 'packages', 'apps']) {
  const baseDir = join(wsRoot, base);
  for await (const pj of walk(baseDir)) {
    try {
      const pkg = JSON.parse(await readFile(pj, 'utf8'));
      if (pkg.name?.startsWith('@deepseek-ai/')) wsPkgs.set(pkg.name, dirname(pj));
    } catch {}
  }
}

let patched = 0;
for (const [name, srcDir] of wsPkgs) {
  const short = name.replace('@deepseek-ai/', '');
  const dstDir = join(target, short);
  if (await exists(dstDir)) continue;            // 已存在，跳过
  const srcLib = join(srcDir, 'lib');
  if (!(await exists(srcLib))) continue;          // 未 build，跳过（如 demo/test 入口）
  await mkdir(dstDir, { recursive: true });
  await copyDir(srcLib, join(dstDir, 'lib'));
  const srcPj = join(srcDir, 'package.json');
  if (await exists(srcPj)) await copyFile(srcPj, join(dstDir, 'package.json'));
  patched++;
  console.log(`[patch] ${short}`);
}
console.log(`[patch] patched ${patched} packages`);
