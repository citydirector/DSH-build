// patch-native-code.mjs <target-node_modules>
//
// 修复上游 deepseek-harness 在构建产物上的两处缺陷（幂等；上游修复后模式不存在
// 则自动跳过，不破坏产物）。
//
// 补丁 1：hasIntrinsicConstructor 的 native-code 字符串比较
//   Function.prototype.toString 对 native 函数在真实浏览器 (Firefox/Chrome) 输出带换行
//   （"function Object() {\n    [native code]\n}"），而 Node.js 输出单行，导致浏览器端
//   walkJsonValue 把普通对象误判为"非 lossless JSON"，assistant stream chunk 校验全失败，
//   消息无法渲染。修复：比较前 replace(/\s+/g, " ") 归一化空白。
//
// 补丁 2：session v2→v3 迁移的 SOURCE_KINDS 白名单缺少历史 kind "instruction-hint"
//   旧版 DSH 会注入 AGENTS.md 提示消息（user/message，source.kind = "instruction-hint"）。
//   新版把该 kind 改名为 "agent-instructions"，但 v2→v3 迁移的白名单没有纳入历史
//   "instruction-hint"，于是含此类消息的历史会话在迁移时抛
//   "cannot safely transform unclassified message source"，导致会话无法加载。
//   修复：把 "instruction-hint" 加入白名单（无损放行，事件原样保留）。
//
// 用法: node patch-native-code.mjs <target-node_modules>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('用法: patch-native-code.mjs <target-node_modules>');
  process.exit(2);
}

// ── 补丁 1：native-code 字符串比较 ─────────────────────────────────────────
const NATIVE_PATTERNS = [
  {
    re: /Function\.prototype\.toString\.call\(([^)]*)\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    repl: (m, arg, eq, tmpl) =>
      `Function.prototype.toString.call(${arg}).replace(/\\s+/g, " ")${eq}${tmpl}`,
  },
  {
    re: /intrinsicReflectApply\(intrinsicFunctionToString,\s*([^,)]*),\s*\[\]\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    repl: (m, arg, eq, tmpl) =>
      `intrinsicReflectApply(intrinsicFunctionToString, ${arg}, []).replace(/\\s+/g, " ")${eq}${tmpl}`,
  },
];

// ── 补丁 2：v2→v3 迁移白名单补 "instruction-hint" ─────────────────────────
// 目标形态（构建产物）:
//   const SOURCE_KINDS = new Set([
//   	"user",
//   	"plugin",
//   ...
function patchSourceKinds(raw) {
  // 已含 instruction-hint：视为已修复
  if (/SOURCE_KINDS\s*=\s*new Set\(\[[\s\S]{0,400}?"instruction-hint"/.test(raw)) return raw;
  const re = /(SOURCE_KINDS\s*=\s*new Set\(\[\s*\n(\s*)"user",)/;
  if (!re.test(raw)) return raw;
  return raw.replace(re, (_m, head, indent) => `${head}\n${indent}"instruction-hint",`);
}

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

// 「已打过补丁」的判据：补丁 1 在比较前插入 .replace(/\s+/g, " ")；补丁 2 的白名单里已有
// "instruction-hint"。两者都能判定，所以「没改、也不像已改」的文件可以被单独拎出来 ——
// 否则它们会被混进 already，看着像「上游已修」，实则补丁静默失效（上游改了写法而我们不知道）。
const ALREADY_NATIVE = /\.replace\(\/\\s\+\/g, " "\)\s*===/;
const ALREADY_SOURCE_KINDS = /SOURCE_KINDS\s*=\s*new Set\(\[[\s\S]{0,400}?"instruction-hint"/;

let scanned = 0, nativePatched = 0, nativeAlready = 0, skPatched = 0, skAlready = 0;
const unmatched = [];
for await (const file of walk(target)) {
  const raw = await readFile(file, 'utf8');
  const hasNative = raw.includes('[native code]');
  const hasSourceKinds = raw.includes('SOURCE_KINDS') && raw.includes('unclassified message source');
  if (!hasNative && !hasSourceKinds) continue;
  scanned++;
  let out = raw;
  if (hasNative) {
    for (const p of NATIVE_PATTERNS) out = out.replace(p.re, p.repl);
    if (out !== raw) { nativePatched++; console.log(`patched(native): ${file.slice(target.length)}`); }
    else if (ALREADY_NATIVE.test(raw)) nativeAlready++;
    else unmatched.push(`${file.slice(target.length)} —— 含 '[native code]'，但既没命中补丁模式、也没有补丁标记`);
  } else {
    out = patchSourceKinds(out);
    if (out !== raw) { skPatched++; console.log(`patched(source-kinds): ${file.slice(target.length)}`); }
    else if (ALREADY_SOURCE_KINDS.test(raw)) skAlready++;
    else unmatched.push(`${file.slice(target.length)} —— 含 SOURCE_KINDS + 'unclassified message source'，但既没命中补丁模式、也没有 "instruction-hint"`);
  }
  if (out !== raw) await writeFile(file, out, 'utf8');
}
console.log(`patch-native-code: scanned=${scanned} native(patched=${nativePatched} already=${nativeAlready}) source-kinds(patched=${skPatched} already=${skAlready}) unmatched=${unmatched.length}`);
if (unmatched.length > 0) {
  // 只告警、不让构建失败：这里也会捞到第三方文件（如 fflate 源码里提到 '[native code]' 的普通
  // 文本），上游也可能合法地删掉整个守卫 —— 两种情况都不该中断每日构建。但要醒目，
  // 别让它淹在绿色日志里。
  console.log('patch-native-code: !! 下列文件带补丁目标特征却未被识别，请人工核对补丁是否仍生效：');
  for (const line of unmatched) console.log(`patch-native-code:   !! ${line}`);
}
if (scanned === 0) {
  console.log('patch-native-code: no targets found (upstream already fixed?)');
}
