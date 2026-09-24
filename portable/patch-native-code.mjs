// patch-native-code.mjs <target-node_modules>
//
// 修复上游 deepseek-harness 在构建产物上的两处缺陷（幂等、可自愈；上游修复后模式不
// 存在则自动跳过，不破坏产物）。
//
// 补丁 1：hasIntrinsicConstructor 的 native-code 字符串比较
//   Function.prototype.toString 对 native 函数在真实浏览器 (Firefox/Chrome) 输出带换行
//   （"function Object() {\n    [native code]\n}"），而 Node.js 输出单行，导致浏览器端
//   walkJsonValue 把普通对象误判为"非 lossless JSON"，assistant stream chunk 校验全失败，
//   消息无法渲染。修复：比较前 replace(/\s+/g, " ") 归一化空白。
//
//   上下文转义（2026-09-24 修复）：
//   同一模式也会出现在**字符串字面量内部**——@deepseek-ai/dsh-workflow-ptc/lib/index.js
//   把整个 guest 源码作为双引号字符串常量（WORKFLOW_GUEST_SOURCE）内联在产物里，其中
//   也有一份 hasIntrinsicConstructor。对字面量内部直接注入裸引号会提前终止字符串，
//   令该模块 SyntaxError；而任何挂载 workflow-ptc 的 agent preset（standard / cordis /
//   自定义预设）都会 mount 失败，Web UI「Agent 预设」卡片显示"加载失败"。
//   因此按上下文决定注入形式：
//     普通代码：   .replace(/\s+/g, " ")
//     字面量内部： .replace(/\\s+/g, \" \")
//   两者在被外层字符串解码后完全等价（反斜杠与引号都多转义一层）。
//
// 用法: node patch-native-code.mjs <target-node_modules>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BS = String.fromCharCode(92);
/** 注入片段（普通代码上下文）。 */
export const PATCH_PLAIN = '.replace(/' + BS + 's+/g, " ")';
/** 注入片段（字符串字面量内部，多转义一层）。 */
export const PATCH_ESCAPED = '.replace(/' + BS + BS + 's+/g, ' + BS + '" ' + BS + '")';

export const NATIVE_PATTERNS = [
  {
    re: /Function\.prototype\.toString\.call\(([^)]*)\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    build: (arg, eq, tmpl) => `Function.prototype.toString.call(${arg})${PATCH_PLAIN}${eq}${tmpl}`,
  },
  {
    re: /intrinsicReflectApply\(intrinsicFunctionToString,\s*([^,)]*),\s*\[\]\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    build: (arg, eq, tmpl) => `intrinsicReflectApply(intrinsicFunctionToString, ${arg}, [])${PATCH_PLAIN}${eq}${tmpl}`,
  },
];

export const ALREADY_SOURCE_KINDS = /SOURCE_KINDS\s*=\s*new Set\(\[\[\s\S\]{0,400}?"instruction-hint"/;

/**
 * 该偏移是否位于一个 JS 字符串/模板字面量内部（只扫描注释、引号与反斜杠转义）。
 * 判断存疑时倾向返回 true：转义比破坏产物安全。
 * @param {string} raw 源码
 * @param {number} offset 目标偏移
 * @returns {boolean} 是否位于字面量内部
 */
export function insideStringLiteral(raw, offset) {
  let quote = null;
  for (let i = 0; i < offset; i++) {
    const c = raw[i];
    if (quote !== null) {
      if (c === BS) { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') { i = raw.indexOf('\n', i); if (i < 0) return false; continue; }
    if (c === '/' && raw[i + 1] === '*') { i = raw.indexOf('*/', i); if (i < 0) return false; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
  }
  return quote !== null;
}

/** 注入文本再转义一层：反斜杠加倍、双引号转义。 */
export function escapeForLiteral(text) {
  return text.split(BS).join(BS + BS).split('"').join(BS + '"');
}

/**
 * 只处理一个文件的补丁 1（native-code）。
 * @param {string} raw 源码
 * @returns {{out: string, patched: boolean, already: boolean, brokenRepaired: boolean, literal: boolean}}
 */
export function patchNative(raw) {
  let out = raw;
  let patched = false;
  let literal = false;
  for (const p of NATIVE_PATTERNS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags), (match, arg, eq, tmpl, offset, whole) => {
      const built = p.build(arg, eq, tmpl);
      patched = true;
      if (insideStringLiteral(whole, offset)) { literal = true; return escapeForLiteral(built); }
      return built;
    });
  }
  // 自愈：字面量内部被写成裸引号（2026-09-24 之前的历史产物，会提前终止字符串）
  let brokenRepaired = false;
  let from = 0;
  for (;;) {
    const at = out.indexOf(PATCH_PLAIN, from);
    if (at < 0) break;
    const tail = out.slice(at + PATCH_PLAIN.length);
    if (/^\s*===/.test(tail) && insideStringLiteral(out, at)) {
      out = out.slice(0, at) + PATCH_ESCAPED + out.slice(at + PATCH_PLAIN.length);
      brokenRepaired = true;
      from = at + PATCH_ESCAPED.length;
      continue;
    }
    from = at + PATCH_PLAIN.length;
  }
  const already = raw.includes(PATCH_PLAIN) || raw.includes(PATCH_ESCAPED);
  // 安全网：注入不得改变文件末尾的字符串状态（错误上下文的注入会让 tokenizer 走进字符串）
  const stateBefore = insideStringLiteral(raw, raw.length);
  const stateAfter = insideStringLiteral(out, out.length);
  if (out !== raw && (brokenRepaired ? stateAfter !== false : stateAfter !== stateBefore)) {
    return { out: raw, patched: false, already, brokenRepaired: false, literal, reverted: true };
  }
  return { out, patched, already, brokenRepaired, literal, reverted: false };
}

/** 补丁 2：v2→v3 迁移白名单补 "instruction-hint"。 */
export function patchSourceKinds(raw) {
  if (ALREADY_SOURCE_KINDS.test(raw)) return raw;
  const re = /(SOURCE_KINDS\s*=\s*new Set\(\[\s*\n(\s*)"user",)/;
  if (!re.test(raw)) return raw;
  return raw.replace(re, (_m, head, indent) => head + '\n' + indent + '"instruction-hint",');
}

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
    console.error('用法: node patch-native-code.mjs <target-node_modules>');
    return 2;
  }
  let scanned = 0, nativePatched = 0, nativeAlready = 0, healed = 0, skPatched = 0, skAlready = 0;
  const unmatched = [];
  for await (const file of walk(target)) {
    const raw = await readFile(file, 'utf8');
    const hasNative = raw.includes('[native code]');
    const hasSourceKinds = raw.includes('SOURCE_KINDS') && raw.includes('unclassified message source');
    if (!hasNative && !hasSourceKinds) continue;
    scanned++;
    const rel = file.slice(target.length);
    let result = raw;
    if (hasNative) {
      const r = patchNative(raw);
      result = r.out;
      if (r.reverted) { unmatched.push(rel + ' —— 注入会破坏字符串状态，已回滚（请人工核对）'); continue; }
      if (r.brokenRepaired) { healed++; console.log('healed(native-literal): ' + rel); }
      if (result !== raw) {
        nativePatched++;
        console.log('patched(native): ' + rel + (r.literal ? ' (含字面量内部，已多转义一层)' : ''));
      } else if (r.already) nativeAlready++;
      else unmatched.push(rel + " —— 含 '[native code]'，但既没命中补丁模式、也没有补丁标记");
    } else {
      result = patchSourceKinds(result);
      if (result !== raw) { skPatched++; console.log('patched(source-kinds): ' + rel); }
      else if (ALREADY_SOURCE_KINDS.test(raw)) skAlready++;
      else unmatched.push(rel + ' —— 含 SOURCE_KINDS + unclassified message source，但既没命中补丁模式、也没有 instruction-hint');
    }
    if (result !== raw) await writeFile(file, result, 'utf8');
  }
  console.log('patch-native-code: scanned=' + scanned + ' native(patched=' + nativePatched + ' healed=' + healed + ' already=' + nativeAlready + ') source-kinds(patched=' + skPatched + ' already=' + skAlready + ') unmatched=' + unmatched.length);
  if (unmatched.length > 0) {
    console.log('patch-native-code: !! 下列文件带补丁目标特征却未被识别，请人工核对补丁是否仍生效：');
    for (const line of unmatched) console.log('patch-native-code:   !! ' + line);
  }
  if (scanned === 0) console.log('patch-native-code: no targets found (upstream already fixed?)');
  return 0;
}

if (import.meta.main) process.exit(await main());
