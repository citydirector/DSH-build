// patch-tool-schema.mjs <target-root>
//
// 在构建产物上摘掉工具 JSON Schema 里的**非字符串 enum**（幂等、可自愈）。
//
// 为什么：cua driver 的 `verify_state` 声明了 `exists: {type:"boolean", enum:[true]}`。
// Gemini function declaration 只支持字符串 enum，本地模型路由（http://localhost:8787，
// Gemini→Anthropic 反代）在翻译 Anthropic `input_schema` 时遇到非字符串 enum，会把**整条请求**
// 打回一句通用的 400（"请求参数或历史报文校验不通过，请检查请求内容或开启新会话重试"）。
// DSH 每次请求都带全部激活工具，于是只要该工具在表里，这条路由**每一次请求都失败**。
// 完整因果见 D:\DSHWorkspace\DSH-Protable\修复计划-2026-10-02-cua-enum-400.md
//
// 打在哪：`@deepseek-ai/dsh-mcp-client` 的 createMcpToolDefinition —— **全部 MCP 来源工具**
// （外部 MCP server 与进程内 cua driver）的公共落点。它的 `parameters: inputSchema` 是逐字
// 透传处：inputSchema 在这里既不校验也不转换（只有 output 走 assertSupportedJsonSchema），
// 所以摘掉一个关键字对下游零影响，schema 仍是合法 JSON Schema。
//
// 为什么是"删"而不是改成 enum:["true"]：布尔实参会永远匹配不上字符串枚举，那是错的。
// Rust 侧仍会拒绝 `false`（exists 的 description 原文已写明 "false is rejected"），语义不丢。
//
// 用法: node patch-tool-schema.mjs <target-root>
//   portable job:  patch-tool-schema.mjs portable\app\node_modules\@deepseek-ai
//   desktop job:   patch-tool-schema.mjs <上游检出根>（P1 步，构建之后、打包之前）
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 注入的助手：函数声明会提升，放哪儿都生效；递归摘掉非字符串 enum（原地改）。 */
const HELPER_SOURCE = [
  '/** DSH-build 补丁：Gemini function declaration 只认字符串 enum，非字符串 enum 会让整条请求被路由打回 400。 */',
  'function dshBuildStripNonStringEnums(node) {',
  '\tif (node === null || typeof node !== "object") return node;',
  '\tif (Array.isArray(node)) {',
  '\t\tfor (const item of node) dshBuildStripNonStringEnums(item);',
  '\t\treturn node;',
  '\t}',
  '\tif (Array.isArray(node.enum) && !node.enum.every((value) => typeof value === "string")) delete node.enum;',
  '\tfor (const key of Object.keys(node)) dshBuildStripNonStringEnums(node[key]);',
  '\treturn node;',
  '}'
].join('\n');
const HELPER_BLOCK = HELPER_SOURCE + '\n\n';

/** 助手定义的识别标记（幂等判据）。 */
export const HELPER_MARK = 'function dshBuildStripNonStringEnums(';
/** 调用点的识别标记（幂等判据）。 */
export const CALL_MARK = /parameters:\s*dshBuildStripNonStringEnums\(inputSchema\)/;

/** 透传函数本身的锚点：只在它**之后**的有界窗口里找调用点，避免误改别的 parameters 赋值。 */
const FUNCTION_ANCHOR = /function createMcpToolDefinition\s*\(/;
/** 有界窗口：锚点到 `parameters: inputSchema` 在打包产物里约 120 字符，留 2000 的余量。 */
const CALL_SITE = /(function createMcpToolDefinition\s*\([\s\S]{0,2000}?\bparameters:\s*)inputSchema\b/;

/** 助手定义与调用点的计数（注入后必须各恰好一次，否则回滚）。 */
function countHelper(src) { return src.split(HELPER_MARK).length - 1; }
function countCall(src) { return src.split('dshBuildStripNonStringEnums(inputSchema)').length - 1; }

/**
 * 给一份源码打补丁。
 * @param raw 源码
 * @returns {{out: string, state: 'patched'|'healed'|'already'|'unmatched'|'absent'|'reverted'}}
 *   patched=本次注入；healed=助手已在但调用点没改，本次只修调用点；
 *   already=两处都已在；unmatched=函数在但调用点形态不认；absent=没有这个函数；
 *   reverted=注入后计数不为 1，已回滚。
 */
export function patchToolSchema(raw) {
  const anchor = FUNCTION_ANCHOR.exec(raw);
  if (anchor === null) return { out: raw, state: 'absent' };
  const hasHelper = raw.includes(HELPER_MARK);
  if (hasHelper && CALL_MARK.test(raw)) return { out: raw, state: 'already' };

  const head = raw.slice(0, anchor.index);
  const tail = raw.slice(anchor.index);
  const rewritten = tail.replace(CALL_SITE, (_m, prefix) => prefix + 'dshBuildStripNonStringEnums(inputSchema)');
  // 函数在、调用点形态不认：不硬塞，交给 unmatched 安全网（宁可漏报也不破坏产物）
  if (rewritten === tail) return { out: raw, state: 'unmatched' };

  const out = hasHelper ? head + rewritten : head + HELPER_BLOCK + rewritten;
  if (countHelper(out) !== 1 || countCall(out) !== 1) return { out: raw, state: 'reverted' };
  return { out, state: hasHelper ? 'healed' : 'patched' };
}

/** 遍历目录里的 .js（跳过 node_modules，与 patch-native-code.mjs 一致）。 */
export async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const target = argv[0];
  if (!target) {
    console.error('用法: node patch-tool-schema.mjs <target-root>');
    return 2;
  }
  let scanned = 0, patched = 0, healed = 0, already = 0;
  const unmatched = [];
  const reverted = [];
  for await (const file of walk(target)) {
    const raw = await readFile(file, 'utf8');
    if (!raw.includes('createMcpToolDefinition')) continue;
    scanned++;
    const rel = file.slice(target.length);
    const r = patchToolSchema(raw);
    if (r.state === 'patched' || r.state === 'healed') {
      await writeFile(file, r.out, 'utf8');
      patched++;
      if (r.state === 'healed') { healed++; console.log('healed(tool-schema): ' + rel); }
      else console.log('patched(tool-schema): ' + rel);
    } else if (r.state === 'already') already++;
    else if (r.state === 'unmatched') unmatched.push(rel + ' —— 有 createMcpToolDefinition，但找不到 `parameters: inputSchema` 透传点');
    else if (r.state === 'reverted') reverted.push(rel + ' —— 注入后助手/调用点计数不为 1，已回滚（请人工核对）');
  }
  console.log('patch-tool-schema: scanned=' + scanned + ' patched=' + patched + ' healed=' + healed
    + ' already=' + already + ' unmatched=' + unmatched.length + ' reverted=' + reverted.length);
  for (const line of reverted) console.log('patch-tool-schema: !! ' + line);
  if (unmatched.length > 0) {
    console.log('patch-tool-schema: !! 下列文件带 createMcpToolDefinition 却未被识别，请人工核对补丁是否仍生效：');
    for (const line of unmatched) console.log('patch-tool-schema:   !! ' + line);
  }
  if (scanned === 0) {
    console.error('patch-tool-schema: 一个含 createMcpToolDefinition 的文件都没扫到 —— 包被挪走/改名了？（root=' + target + '）');
    return 2;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
