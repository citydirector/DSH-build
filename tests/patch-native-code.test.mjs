// patch-native-code.test.mjs
// 验证 patch-native-code.mjs 的上下文转义、自愈与幂等行为：
//   1) 普通代码上下文：注入 .replace(/\s+/g, " ")
//   2) 字符串字面量内部（WORKFLOW_GUEST_SOURCE 形态）：多转义一层
//      .replace(/\\s+/g, \" \")，解码后与 1) 完全等价
//   3) 历史损坏形态（字面量内部写成裸引号 → 提前终止字符串）：自愈
//   4) 幂等：第二次运行零改动
//   5) 仅注释里提到 '[native code]' 的第三方文件：不动它
// 用独立 fixture 构造（script 形态，便于用 vm.Script 直接校验），不依赖真实上游产物；可在 CI 里跑。
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repo, 'portable', 'patch-native-code.mjs');

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
// 普通上下文注入片段
const PLAIN = '.replace(/' + BS + 's+/g, " ")';
// 字面量内部注入片段：反斜杠与引号都多转义一层（正确的字面量形态）
const IN_LITERAL_OK = '.replace(/' + BS + BS + 's+/g, ' + BS + '" ' + BS + '")';
// 上游形态：Function.prototype.toString.call(X) === `function ${name}() { [native code] }`
const TMPL = '`function ' + '${name}' + '() { [native code] }`';
const site = (arg) => 'Function.prototype.toString.call(' + arg + ') === ' + TMPL;

/** 上游（未打补丁）的普通代码文件。 */
const NORMAL_UPSTREAM = [
  'function hasIntrinsicConstructor(prototype, name) {',
  '  const c = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;',
  '  if (typeof c !== "function") return false;',
  '  try {',
  '    return c.name === name && c.prototype === prototype && ' + site('c') + ';',
  '  } catch {',
  '    return false;',
  '  }',
  '}',
  ''
].join(NL);

/** 把一段源码塞进双引号字面量：先加倍反斜杠、再转义引号、最后转义换行。 */
function embedAsLiteral(source) {
  const body = source.split(BS).join(BS + BS).split('"').join(BS + '"').split(NL).join(BS + 'n');
  return 'const WORKFLOW_GUEST_SOURCE = "' + body + '";' + NL + 'const runWorkflowGuest = (host) => host;' + NL;
}

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✅ ' + msg);
  else { console.error('  ❌ ' + msg); failures++; }
}
function parsesAsScript(src) {
  try { new vm.Script(src); return true; } catch { return false; }
}
/** 取出文件里第一个双引号字面量的解码内容（按转义规则找真正的收尾引号）。 */
function decodeFirstLiteral(src) {
  const start = src.indexOf('"');
  if (start < 0) return undefined;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === BS) { i++; continue; }
    if (c === '"') {
      try { return Function('return ' + src.slice(start, i + 1))(); } catch { return undefined; }
    }
  }
  return undefined;
}
function runScript(target) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
async function fixture(files) {
  const base = await mkdtemp(join(tmpdir(), 'pnc-'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(base, name), content);
  return base;
}

// ---- 场景 1：普通上下文 + 字面量内部 + 第三方噪声，一次运行全部处理 ----
{
  const guest = embedAsLiteral(NORMAL_UPSTREAM);
  const f = await fixture({
    'normal.js': NORMAL_UPSTREAM,
    'guest.js': guest,
    'third-party.js': '// mentions [native code] only in a comment' + NL + 'const x = 1;' + NL
  });
  const r = await runScript(f);
  ok(r.code === 0, '场景1: 运行成功 (exit 0)');
  const normal = await readFile(join(f, 'normal.js'), 'utf8');
  ok(normal.includes(PLAIN), '场景1: 普通上下文注入 .replace(/\s+/g, " ")');
  ok(!normal.includes(IN_LITERAL_OK), '场景1: 普通上下文没有被多转义');
  ok(parsesAsScript(normal), '场景1: 普通文件仍可解析');

  const g = await readFile(join(f, 'guest.js'), 'utf8');
  ok(parsesAsScript(g), '场景1: 含字面量的文件仍可解析（没有被提前终止）');
  const decoded = decodeFirstLiteral(g);
  ok(typeof decoded === 'string', '场景1: 字面量可解码');
  ok(typeof decoded === 'string' && decoded.includes(PLAIN), '场景1: 解码后的 guest 源码拿到等价注入');
  ok(typeof decoded === 'string' && parsesAsScript(decoded), '场景1: 解码后的 guest 源码可解析');
  ok(g.includes(IN_LITERAL_OK), '场景1: 字面量内部按转义形态写入');

  const noise = await readFile(join(f, 'third-party.js'), 'utf8');
  ok(noise.includes('[native code]') && !noise.includes('replace('), '场景1: 仅注释提及的文件未被改写');
  ok(r.out.includes('unmatched=1'), '场景1: 该文件被列为未识别（unmatched=1）');

  // ---- 场景 2：幂等 ----
  const r2 = await runScript(f);
  const normal2 = await readFile(join(f, 'normal.js'), 'utf8');
  const guest2 = await readFile(join(f, 'guest.js'), 'utf8');
  ok(r2.code === 0, '场景2: 第二次运行成功 (exit 0)');
  ok(normal2 === normal && guest2 === g, '场景2: 第二次运行零改动（幂等）');
  ok(r2.out.includes('already=2'), '场景2: 两个文件被判为已打补丁 (already=2)');
  await rm(f, { recursive: true, force: true });
}

// ---- 场景 3：自愈历史损坏形态（字面量内部被写成裸引号 → 提前终止字符串）----
{
  const injectedSource = NORMAL_UPSTREAM.split(site('c')).join('c.name === name && ' + PLAIN + ' === ' + TMPL);
  const brokenGuest = embedAsLiteral(injectedSource).split(IN_LITERAL_OK).join(PLAIN);
  const f = await fixture({ 'guest.js': brokenGuest });
  ok(brokenGuest.includes(IN_LITERAL_OK) === false && brokenGuest.includes(PLAIN), '场景3: fixture 构造为裸引号形态');
  ok(!parsesAsScript(brokenGuest), '场景3: 初始 fixture 确实是坏的（不可解析）');
  const r = await runScript(f);
  ok(r.code === 0, '场景3: 运行成功 (exit 0)');
  const fixed = await readFile(join(f, 'guest.js'), 'utf8');
  ok(parsesAsScript(fixed), '场景3: 自愈后可解析');
  const decoded = decodeFirstLiteral(fixed);
  ok(typeof decoded === 'string' && decoded.includes(PLAIN), '场景3: 解码后拿到等价注入');
  ok(r.out.includes('healed'), '场景3: 日志报告自愈 (healed)');
  await rm(f, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.error('patch-native-code tests: ' + failures + ' 项失败');
  process.exit(1);
}
console.log('patch-native-code tests: 全部通过');
