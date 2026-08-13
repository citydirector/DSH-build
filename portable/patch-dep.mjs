// patch-dep.mjs <root-node_modules> <target-node_modules> <seed-dep...>
// pnpm deploy 会漏掉 workspace 包的 registry 依赖（实测 cordis-plugin-hmr 的
// @babel/code-frame 没被带上）。本脚本从 root node_modules 递归复制指定种子包
// 及其 dependencies/optionalDependencies 闭包到 target，补齐缺失。
import { readFile, mkdir, stat, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const rootNM = process.argv[2];
const targetNM = process.argv[3];
const seeds = process.argv.slice(4);

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
    if (d.startsWith('@deepseek-ai/')) continue;
    await ensure(d);
  }
}

for (const s of seeds) await ensure(s);
console.log(`[dep] copied ${copied} packages`);
