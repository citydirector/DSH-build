// patch-tool-schema.test.mjs
// 验证 patch-tool-schema.mjs 的注入、幂等、自愈、安全网，以及注入助手的**运行时语义**：
//   1) 上游形态：注入助手 + 改写调用点；函数体外同形的赋值不许被误改
//   2) 幂等：第二次运行零改动，already=1
//   3) 自愈：助手在、调用点被还原 → 只修调用点，产物与一次打好的逐字节一致
//   4) unmatched：有 createMcpToolDefinition、没有 `parameters: inputSchema` 透传点 → 不硬塞，报告警，exit 0
//   5) 一个含该函数的文件都没扫到 → exit 2（包被挪走/改名）
//   6) 助手语义：非字符串 enum 摘掉（含嵌套/数组/混合），字符串 enum 分毫不动，非对象入参不炸
//   7) ESM 形态：export 语句原样保留，产物语法可解析
// 用独立 fixture 构造，不依赖真实上游产物；可在 CI 里跑。
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repo, 'portable', 'patch-tool-schema.mjs');

/** 上游（未打补丁）的脚本形态产物；故意在函数**之前**放一处同形赋值，验证有界窗口。 */
const UPSTREAM_SCRIPT = [
  'function unrelated() {',
  '  return { parameters: inputSchema };',
  '}',
  'function createOutput(rawName, structuredSchema) {',
  '  return { schema: { type: "object" }, render() { return []; } };',
  '}',
  'function createMcpToolDefinition(ctx, options) {',
  '  const { name, rawName, description, inputSchema } = options;',
  '  const projections = new WeakMap();',
  '  return {',
  '    name,',
  '    description,',
  '    parameters: inputSchema,',
  '    output: createOutput(rawName, options.outputSchema),',
  '    execute: function () { return projections; }',
  '  };',
  '}',
  ''
].join('\n');

/** ESM 打包产物形态：与脚本形态同构，末尾多一条 export。 */
const UPSTREAM_ESM = UPSTREAM_SCRIPT + 'export { createMcpToolDefinition, createOutput };\n';

/** 形态变了的产物：透传点不再直接写 inputSchema。 */
const SHIFTED = UPSTREAM_SCRIPT.replace('parameters: inputSchema,', 'parameters: options.inputSchema,');

const HELPER_MARK = 'function dshBuildStripNonStringEnums(';
const CALL_TEXT = 'parameters: dshBuildStripNonStringEnums(inputSchema),';

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✅ ' + msg);
  else { console.error('  ❌ ' + msg); failures++; }
}
function parsesAsScript(src) {
  try { new vm.Script(src); return true; } catch { return false; }
}
function countOf(hay, needle) { return hay.split(needle).length - 1; }

/** 用花括号配对把注入的助手整段抠出来（助手体内没有花括号字面量，配对可靠）。 */
function extractHelper(src) {
  const at = src.indexOf(HELPER_MARK);
  if (at < 0) return undefined;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return undefined;
}

function runScript(target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function scenario1() {
  console.log('场景1: 上游脚本形态 —— 注入助手 + 改写调用点');
  const dir = await mkdtemp(join(tmpdir(), 'tool-schema-'));
  await mkdir(join(dir, 'pkg', 'lib'), { recursive: true });
  const file = join(dir, 'pkg', 'lib', 'index.js');
  await writeFile(file, UPSTREAM_SCRIPT, 'utf8');

  const r = await runScript(dir);
  const patched = await readFile(file, 'utf8');
  ok(r.code === 0, '场景1: exit 0');
  ok(r.out.includes('patched=1'), '场景1: 报告 patched=1');
  ok(r.out.includes('unmatched=0'), '场景1: 没有未识别告警');
  ok(countOf(patched, HELPER_MARK) === 1, '场景1: 助手恰好定义一次');
  ok(countOf(patched, CALL_TEXT) === 1, '场景1: 调用点恰好改写一次');
  ok(patched.includes('delete node.enum'), '场景1: 助手体带 delete node.enum');
  ok(patched.includes('  return { parameters: inputSchema };'), '场景1: 函数体外的同形赋值未被误改');
  ok(patched.includes('parameters: dshBuildStripNonStringEnums(inputSchema),'), '场景1: 透传点已包上助手');
  ok(patched.includes('output: createOutput(rawName, options.outputSchema),'), '场景1: 相邻字段未被动');
  ok(parsesAsScript(patched), '场景1: 产物可解析');

  // 助手语义：把注入的那份抠出来真跑一遍
  const ctx = {};
  vm.runInNewContext(extractHelper(patched) + '\nthis.strip = dshBuildStripNonStringEnums;', ctx);
  const strip = ctx.strip;
  ok(typeof strip === 'function', '场景1: 助手可被求值为函数');

  const boolSchema = { type: 'boolean', enum: [true] };
  strip(boolSchema);
  ok(boolSchema.enum === undefined && boolSchema.type === 'boolean', '场景1: 布尔 enum 被摘掉、type 保留');

  const strSchema = { type: 'string', enum: ['a', 'b'] };
  const strBefore = JSON.stringify(strSchema);
  strip(strSchema);
  ok(JSON.stringify(strSchema) === strBefore, '场景1: 字符串 enum 分毫不动');

  const mixed = { type: 'number', enum: [1, 2] };
  strip(mixed);
  ok(mixed.enum === undefined, '场景1: 数字 enum 也摘掉（Gemini 只认字符串）');

  const mixed2 = { enum: ['a', 1] };
  strip(mixed2);
  ok(mixed2.enum === undefined, '场景1: 混合 enum 摘掉');

  const deep = { properties: { expect: { items: { properties: { exists: { type: 'boolean', enum: [true] } } } } } };
  strip(deep);
  ok(deep.properties.expect.items.properties.exists.enum === undefined, '场景1: 深层嵌套的 enum 被摘掉');
  ok(deep.properties.expect.items.properties.exists.type === 'boolean', '场景1: 深层结构其余部分保留');

  const viaArray = { anyOf: [{ type: 'boolean', enum: [true] }, { type: 'string' }] };
  strip(viaArray);
  ok(viaArray.anyOf[0].enum === undefined && viaArray.anyOf[1].type === 'string', '场景1: 数组内的 enum 被摘掉');

  ok(strip(undefined) === undefined && strip(null) === null && strip('x') === 'x' && strip(7) === 7, '场景1: 非对象入参原样返回、不抛');

  // 幂等
  const r2 = await runScript(dir);
  const again = await readFile(file, 'utf8');
  ok(r2.code === 0, '场景1: 第二次运行 exit 0');
  ok(again === patched, '场景1: 第二次运行零改动（幂等）');
  ok(r2.out.includes('patched=0') && r2.out.includes('already=1'), '场景1: 次轮报告 patched=0 already=1');

  // 自愈：助手在、调用点被还原
  const broken = patched.replace(CALL_TEXT, 'parameters: inputSchema,');
  ok(broken !== patched && broken.includes(HELPER_MARK), '场景1: 构造出"助手在、调用点丢"的中间态');
  await writeFile(file, broken, 'utf8');
  const r3 = await runScript(dir);
  const healed = await readFile(file, 'utf8');
  ok(r3.code === 0, '场景1: 第三次运行 exit 0');
  ok(r3.out.includes('healed=1'), '场景1: 报告 healed=1');
  ok(healed === patched, '场景1: 自愈结果与一次打好的逐字节一致');
  ok(countOf(healed, HELPER_MARK) === 1, '场景1: 自愈不会重复注入助手');

  await rm(dir, { recursive: true, force: true });
}

async function scenario2() {
  console.log('场景2: 透传点形态变了 —— 不硬塞，报 unmatched，exit 0');
  const dir = await mkdtemp(join(tmpdir(), 'tool-schema-'));
  await writeFile(join(dir, 'index.js'), SHIFTED, 'utf8');
  const r = await runScript(dir);
  const after = await readFile(join(dir, 'index.js'), 'utf8');
  ok(r.code === 0, '场景2: exit 0（告警不拦构建）');
  ok(r.out.includes('unmatched=1'), '场景2: 报告 unmatched=1');
  ok(r.out.includes('createMcpToolDefinition'), '场景2: 告警点名了那个文件');
  ok(after === SHIFTED, '场景2: 文件零改动');
  ok(!after.includes(HELPER_MARK), '场景2: 没有硬塞助手进去');
  await rm(dir, { recursive: true, force: true });
}

async function scenario3() {
  console.log('场景3: 一个含该函数的文件都没扫到 —— exit 2');
  const dir = await mkdtemp(join(tmpdir(), 'tool-schema-'));
  await writeFile(join(dir, 'index.js'), 'export const nothing = 1;\n', 'utf8');
  const r = await runScript(dir);
  ok(r.code === 2, '场景3: exit 2');
  ok(r.out.includes('都没扫到'), '场景3: 说明了原因');
  await rm(dir, { recursive: true, force: true });
}

async function scenario4() {
  console.log('场景4: ESM 产物形态 —— export 保留、语法可解析');
  const dir = await mkdtemp(join(tmpdir(), 'tool-schema-'));
  const file = join(dir, 'index.js');
  await writeFile(file, UPSTREAM_ESM, 'utf8');
  const r = await runScript(dir);
  const patched = await readFile(file, 'utf8');
  ok(r.code === 0 && r.out.includes('patched=1'), '场景4: 打上了补丁');
  ok(patched.includes('export { createMcpToolDefinition, createOutput };'), '场景4: export 语句原样保留');
  ok(countOf(patched, HELPER_MARK) === 1 && countOf(patched, CALL_TEXT) === 1, '场景4: 助手与调用各一次');
  ok(parsesAsScript(patched.replace(/^export .*$/mu, '')), '场景4: 去掉 export 后语法可解析');
  if (process.versions.bun === undefined) {
    // 真 Node 才能用 --check 校验 ESM 语法（Bun 的 node --check 被当成"执行"，会假失败）
    const check = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    ok(check.code === 0, '场景4: node --check 通过（ESM 语法有效）' + (check.code === 0 ? '' : ' :: ' + check.out.trim()));
  } else {
    console.log('  ⏭  场景4: 跳过 node --check（当前 node 是 Bun 包装器）');
  }
  await rm(dir, { recursive: true, force: true });
}

await scenario1();
console.log('');
await scenario2();
console.log('');
await scenario3();
console.log('');
await scenario4();

console.log('');
if (failures > 0) {
  console.error('patch-tool-schema tests: ' + failures + ' 项失败');
  process.exit(1);
}
console.log('patch-tool-schema tests: 全部通过');
