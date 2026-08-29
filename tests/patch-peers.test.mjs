// patch-peers.test.mjs
// 验证 patch-peers.mjs 的两个关键行为：
//   1) 源码缺 build 产物时，能从 hoisted 根 node_modules 兜底补齐（schemastery 场景）。
//   2) 部署图里某 @deepseek-ai 依赖在所有来源都缺失时，终止构建（非零退出）+ 明确报错。
// 用独立临时 fixture 构造，不依赖真实上游；可本地跑，也可在 CI 里跑。
import { mkdtemp, writeFile, mkdir, rm, readdir, stat, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repo, 'portable', 'patch-peers.mjs');

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✅ ' + msg);
  else { console.error('  ❌ ' + msg); failures++; }
}

async function writeJson(p, obj) { await writeFile(p, JSON.stringify(obj, null, 2)); }

// fixture: ws 根 + hoisted 根 + 部署目标 target
//   root/node_modules/@deepseek-ai/<pkg>    hoisted 来源（含 lib）
//   root/vendor|packages/<pkg>               ws 源码（可缺 lib）
//   deploy/node_modules/@deepseek-ai/<pkg>   部署目标
async function fixture({ hoistedHas = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pp-'));
  await mkdir(join(base, 'root', 'node_modules', '@deepseek-ai'), { recursive: true });

  // hoisted 来源：schemastery 带 lib，cosmokit 带 lib
  const hoistedScope = join(base, 'root', 'node_modules', '@deepseek-ai');
  if (hoistedHas) {
    await mkdir(join(hoistedScope, 'schemastery', 'lib'), { recursive: true });
    await writeJson(join(hoistedScope, 'schemastery', 'package.json'), {
      name: '@deepseek-ai/schemastery', version: '3.18.1',
      main: 'lib/index.mjs', type: 'module',
    });
    await writeFile(join(hoistedScope, 'schemastery', 'lib', 'index.mjs'), 'export default {};\n');
  }
  await mkdir(join(hoistedScope, 'cosmokit', 'lib'), { recursive: true });
  await writeJson(join(hoistedScope, 'cosmokit', 'package.json'), {
    name: '@deepseek-ai/cosmokit', version: '1.0.0', main: 'lib/index.mjs', type: 'module',
  });
  await writeFile(join(hoistedScope, 'cosmokit', 'lib', 'index.mjs'), 'export default {};\n');

  // ws 源码：schemastery 无 lib（模拟 build:official 未产出），cosmokit 有 lib
  for (const [pkg, hasLib] of [['schemastery', false], ['cosmokit', true]]) {
    const dir = join(base, 'root', 'vendor', pkg);
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, 'package.json'), {
      name: '@deepseek-ai/' + pkg, version: '1.0.0', main: 'lib/index.mjs', type: 'module',
    });
    if (hasLib) {
      await mkdir(join(dir, 'lib'), { recursive: true });
      await writeFile(join(dir, 'lib', 'index.mjs'), 'export default {};\n');
    }
  }

  // ws 源码：dsh-system-prompt（声明依赖 schemastery，peer 依赖 cosmokit）
  const spDir = join(base, 'root', 'packages', 'dsh-system-prompt');
  await mkdir(spDir, { recursive: true });
  await writeJson(join(spDir, 'package.json'), {
    name: '@deepseek-ai/dsh-system-prompt', version: '1.0.0',
    dependencies: { '@deepseek-ai/schemastery': 'workspace:^' },
    peerDependencies: { '@deepseek-ai/cosmokit': 'workspace:^' },
  });

  // 部署目标：已有 dsh-system-prompt，缺 schemastery / cosmokit
  const deployScope = join(base, 'deploy', 'node_modules', '@deepseek-ai');
  await mkdir(join(deployScope, 'dsh-system-prompt'), { recursive: true });
  await writeJson(join(deployScope, 'dsh-system-prompt', 'package.json'), {
    name: '@deepseek-ai/dsh-system-prompt', version: '1.0.0',
    dependencies: { '@deepseek-ai/schemastery': 'workspace:^' },
  });

  return { base, wsRoot: join(base, 'root'), target: deployScope };
}

function runScript(wsRoot, target) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, wsRoot, target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
async function existsDir(p) { try { await stat(p); return true; } catch { return false; } }

// ---- 场景 1：schemastery 在 hoisted 有 lib，源码无 lib → 兜底补齐，构建通过 ----
{
  const f = await fixture({ hoistedHas: true });
  const r = await runScript(f.wsRoot, f.target);
  ok(r.code === 0, '场景1: hoisted 兜底补齐后构建通过 (exit 0)');
  ok(await existsDir(join(f.target, 'schemastery', 'lib', 'index.mjs')),
      '场景1: schemastery 被复制到部署目标');
  ok(r.out.includes('hoisted'), '场景1: 日志标注使用 hoisted 兜底');
  await rm(f.base, { recursive: true, force: true });
}

// ---- 场景 2：schemastery 所有来源都缺 → 终止构建（非零退出 + 明确报错）----
{
  const f = await fixture({ hoistedHas: false });
  const r = await runScript(f.wsRoot, f.target);
  ok(r.code !== 0, '场景2: schemastery 无来源时构建失败 (非零退出)');
  ok((r.out + r.err).includes('schemastery'), '场景2: 报错提到缺失的 schemastery');
  ok((r.out + r.err).includes('缺失') || (r.out + r.err).includes('终止构建'),
      '场景2: 报错信息明确（缺依赖→终止构建）');
  await rm(f.base, { recursive: true, force: true });
}

// ---- 场景 3：目标已具备全部 @deepseek-ai 依赖 → 直接通过、不误报 ----
{
  const f = await fixture({ hoistedHas: true });
  // 让目标自足：添上 schemastery & cosmokit
  await mkdir(join(f.target, 'schemastery', 'lib'), { recursive: true });
  await writeFile(join(f.target, 'schemastery', 'lib', 'index.mjs'), 'export default {};\n');
  await writeFile(join(f.target, 'schemastery', 'lib', 'sentinel.txt'), 'sentinel\n');
  await writeJson(join(f.target, 'schemastery', 'package.json'), {
    name: '@deepseek-ai/schemastery', version: '3.18.1', main: 'lib/index.mjs', type: 'module',
  });
  await mkdir(join(f.target, 'cosmokit', 'lib'), { recursive: true });
  await writeFile(join(f.target, 'cosmokit', 'lib', 'index.mjs'), 'export default {};\n');
  await writeJson(join(f.target, 'cosmokit', 'package.json'), {
    name: '@deepseek-ai/cosmokit', version: '1.0.0', main: 'lib/index.mjs', type: 'module',
  });

  const r = await runScript(f.wsRoot, f.target);
  ok(r.code === 0, '场景3: 目标自足时构建通过 (exit 0)');
  // 已存在的包不应被重复覆盖（哨兵文件应保留）
  ok(await existsDir(join(f.target, 'schemastery', 'lib', 'sentinel.txt')),
      '场景3: 已存在的 schemastery 未被重复覆盖');
  await rm(f.base, { recursive: true, force: true });
}

// ---- 场景 4：目标里的 @deepseek-ai 包是符号链接 → 替换成真实副本（防打包被跳过）----
{
  const f = await fixture({ hoistedHas: true });
  // ws 源码给 schemastery 补上 lib（这样 patch-peers 能重新生成真实副本）
  const srcSche = join(f.wsRoot, 'vendor', 'schemastery');
  await mkdir(join(srcSche, 'lib'), { recursive: true });
  await writeFile(join(srcSche, 'lib', 'index.mjs'), 'export default {};\n');
  // 目标里 schemastery 建为【符号链接】指向源码（模拟 pnpm deploy 的联结点）
  const targetSche = join(f.target, 'schemastery');
  await symlink(join(srcSche, 'lib'), targetSche, 'dir');
  // 目标里其他依赖保持自足，单独验证 schemastery 从链接变真实
  await mkdir(join(f.target, 'cosmokit', 'lib'), { recursive: true });
  await writeFile(join(f.target, 'cosmokit', 'lib', 'index.mjs'), 'export default {};\n');
  await writeJson(join(f.target, 'cosmokit', 'package.json'), {
    name: '@deepseek-ai/cosmokit', version: '1.0.0', main: 'lib/index.mjs', type: 'module',
  });

  const r = await runScript(f.wsRoot, f.target);
  ok(r.code === 0, '场景4: 符号链接替换为真实副本后构建通过 (exit 0)');
  ok(r.out.includes('符号链接'), '场景4: 日志标注替换符号链接');
  const st = await lstat(targetSche);
  ok(!st.isSymbolicLink(), '场景4: schemastery 已不再是符号链接');
  ok(await existsDir(join(targetSche, 'lib', 'index.mjs')), '场景4: 真实副本含 lib 产物');
  await rm(f.base, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 个失败`);
process.exit(failures === 0 ? 0 : 1);
