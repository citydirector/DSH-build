// patch-dep.mjs <root-node_modules> <target-node_modules> <seed-dep...>
// pnpm deploy 会漏掉 workspace 包的 registry 依赖（实测 cordis-plugin-hmr 的
// @babel/code-frame 没被带上）。本脚本从 root node_modules 递归复制指定种子包
// 及其 dependencies/optionalDependencies 闭包到 target，补齐缺失。
//
// 2026-09-27 追加：**同时把种子声明进 target 的 package.json**。
// 光把文件拷进 node_modules 不够 —— dsh 判断"哪些包能被 profile 的插件行解析"时，看的是
// **安装清单的 dependencies ∪ peerDependencies**（dsh-app-boot：
// "Return installed direct dependencies that Node resolves before profile fallback"）。
// 实测：computer-use 的注册表与提供方文件都在位，却因为清单里没声明而被判未安装，插件行整套
// 消失，stderr 只有一句 "failed to import"（GUI 应用看不到）。补上声明后，同一份 profile
// 立刻正常激活。
//
// 用法: node patch-dep.mjs <root-node_modules> <target-node_modules> <seed-dep...>
import { readFile, mkdir, stat, readdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const rootNM = process.argv[2];
const targetNM = process.argv[3];
const seeds = process.argv.slice(4);
/** 目标安装的清单：dsh 就是照它决定哪些包可被插件行解析。 */
const targetManifestPath = join(targetNM, '..', 'package.json');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

let copied = 0;
async function ensure(name) {
  const rel = name.split('/');
  if (await exists(join(targetNM, ...rel))) return;           // 已存在，跳过
  const src = join(rootNM, ...rel);
  if (!(await exists(src))) { console.warn(`[dep] ${name} 缺失于 root，跳过`); return; }
  await copyDir(src, join(targetNM, ...rel));
  copied++;
  console.log(`[dep] ${name}`);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(src, 'package.json'), 'utf8')); } catch { return; }
  for (const d of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    // workspace 包（@deepseek-ai/*）由 patch-peers 带，不从这里递归拷
    if (d.startsWith('@deepseek-ai/')) continue;
    await ensure(d);
  }
}

for (const s of seeds) await ensure(s);
console.log(`[dep] copied ${copied} packages`);

// 声明种子（文件是这次拷的、还是 patch-peers 拷进来的 workspace 包，都要声明）。
let manifest;
try {
  manifest = JSON.parse(await readFile(targetManifestPath, 'utf8'));
} catch (error) {
  throw new Error(`patch-dep: 读不到目标清单 ${targetManifestPath}（没有它，插件行会被判未安装）：${error.message}`);
}
if (manifest.dependencies === undefined || typeof manifest.dependencies !== 'object' || manifest.dependencies === null) {
  throw new Error(`patch-dep: ${targetManifestPath} 没有 dependencies 对象，上游改了结构？`);
}
const declared = [];
for (const name of seeds) {
  if (manifest.dependencies[name] !== undefined) continue;
  let pkg;
  try { pkg = JSON.parse(await readFile(join(targetNM, ...name.split('/'), 'package.json'), 'utf8')); }
  catch { console.warn(`[dep] ${name} 在 target 里没有清单，无法声明，跳过`); continue; }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`patch-dep: ${name} 的清单没有 version，无法声明（不用通配版本糊过去）`);
  }
  manifest.dependencies[name] = pkg.version;
  declared.push(`${name}@${manifest.dependencies[name]}`);
}
if (declared.length > 0) {
  await writeFile(targetManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[dep] declared in ${targetManifestPath}: ${declared.join(', ')}`);
} else {
  console.log(`[dep] already declared: ${seeds.join(', ')}`);
}
