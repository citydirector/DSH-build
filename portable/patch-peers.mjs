// patch-peers.mjs <workspace-root> <target-node_modules>
// deploy 会系统性漏掉 workspace 包之间的 peer 依赖（auto-install-peers 对 deploy 无效）。
// 本脚本遍历 workspace 全部 @deepseek-ai 包，把 target node_modules 里缺失的包补齐：
//   优先复制该包的 lib/ + package.json（build 产物已生成）；若源码缺 build 产物，
//   则从 hoisted 根 node_modules 兜底复制（hoisted 会把 workspace 包连同产物提升到根）。
//
// 关键坑：pnpm deploy 会把 workspace 包装成符号链接/联结点，而 Compress-Archive 打包时
// 不跟随符号链接，导致 schemastery 这类包在产物里消失（CI 上能解析、本地却 ERR_MODULE_NOT_FOUND）。
// 所以对已存在的表项：若是符号链接/联结点，删除并替换成真实副本（lib + package.json）。
//
// 最后校验：所有已部署 @deepseek-ai 包的 @deepseek-ai 依赖必须能解析到，否则抛错终止构建，
// 避免把缺包的坏产物静默发布出去。
import { readdir, readFile, mkdir, stat, lstat, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const wsRoot = process.argv[2];
const target = process.argv[3];
if (!wsRoot || !target) {
  console.error('用法: patch-peers.mjs <workspace-root> <target-node_modules>');
  process.exit(2);
}
const hoistedNM = join(wsRoot, 'node_modules', '@deepseek-ai');

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
async function isSymlink(p) {
  try { return (await lstat(p)).isSymbolicLink(); } catch { return false; }
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

// 1. 收集全部 workspace @deepseek-ai 包
const wsPkgs = new Map();
for (const base of ['vendor', 'packages', 'apps', 'native']) {
  const baseDir = join(wsRoot, base);
  for await (const pj of walk(baseDir)) {
    try {
      const pkg = JSON.parse(await readFile(pj, 'utf8'));
      if (pkg.name && pkg.name.startsWith('@deepseek-ai/')) wsPkgs.set(pkg.name, dirname(pj));
    } catch {}
  }
}

// 2. 补齐缺失的 workspace 包 + 把符号链接替换为真实副本
let patched = 0;
const noBuild = [];
for (const pair of wsPkgs) {
  const name = pair[0], srcDir = pair[1];
  const short = name.slice('@deepseek-ai/'.length);
  const dstDir = join(target, short);

  // 已存在：真实目录保留；符号链接/联结点 → 删除后重新生成真实副本（否则打包被跳过）
  if (await exists(dstDir)) {
    if (!(await isSymlink(dstDir))) continue;
    console.log(`[patch] ${short} 是符号链接，替换为真实副本`);
    await rm(dstDir, { recursive: true, force: true });
  }

  // 找 build 产物：先 ws 源码 lib，再 hoisted 根 node_modules
  let srcLib = join(srcDir, 'lib');
  let pkgSrc = srcDir;
  let viaHoisted = false;
  if (!(await exists(srcLib))) {
    const hoisted = join(hoistedNM, short);
    if (await exists(join(hoisted, 'lib'))) {
      srcLib = join(hoisted, 'lib');
      pkgSrc = hoisted;
      viaHoisted = true;
      console.log(`[patch] ${short} 使用 hoisted 兜底构建`);
    } else {
      noBuild.push(short);
      continue;
    }
  }

  await mkdir(dstDir, { recursive: true });
  await copyDir(srcLib, join(dstDir, 'lib'));
  const srcPj = join(pkgSrc, 'package.json');
  if (await exists(srcPj)) await copyFile(srcPj, join(dstDir, 'package.json'));
  patched++;
  console.log(`[patch] ${short}${viaHoisted ? ' [hoisted]' : ''}`);
}

// 3. 校验 @deepseek-ai 依赖完整性
async function scopedPresent(short) {
  const d = join(target, short);
  if (await exists(join(d, 'package.json'))) return true;
  return await exists(d);
}
const missing = new Set();
for (const f of await readdir(target)) {
  const pj = join(target, f, 'package.json');
  if (!(await exists(pj))) continue;
  let pkg;
  try { pkg = JSON.parse(await readFile(pj, 'utf8')); } catch { continue; }
  const deps = pkg.dependencies || {};
  for (const dep of Object.keys(deps)) {
    if (!dep.startsWith('@deepseek-ai/')) continue;
    if (!(await scopedPresent(dep.slice('@deepseek-ai/'.length)))) missing.add(dep);
  }
}

console.log(`[patch] patched ${patched} packages`);
if (noBuild.length) {
  console.warn(`[patch] 警告: 以下 workspace 包在源码与 hoisted 均无 build 产物（可能为 demo/test 入口）: ${noBuild.join(', ')}`);
}
if (missing.size) {
  throw new Error(`[patch] 部署缺失 @deepseek-ai 依赖: ${Array.from(missing).join(', ')}。deploy/peers 补齐不完整，终止构建以免发布坏包。`);
}
