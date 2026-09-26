// patch-native-code.mjs <target-node_modules>
//
// 在构建产物上应用两处本地修复（幂等、可自愈：模式不存在即跳过）。
//
// 1. native-code 比较前要归一化空白：真实浏览器把 native 函数的 Function.prototype.toString
//    输出成多行、Node 输出单行，浏览器端 walkJsonValue 会把普通对象误判成非 lossless JSON，
//    assistant stream chunk 校验随之全失败（消息渲染不出来）。
//    同一模式还内联在字符串字面量里（dsh-workflow-ptc 把 guest 源码整段塞进双引号字符串），
//    注入裸引号会提前终止字符串 → 该 preset 挂载失败，所以按上下文给两种注入形式
//    （PATCH_PLAIN / PATCH_ESCAPED，解码后等价）。
//
// 2. session 迁移 v2→v3 的 SOURCE_KINDS 白名单缺历史 kind "instruction-hint"（旧版 DSH 注入的
//    AGENTS.md 提示消息用它）。改动点只有这一处，但 v2 会话必须先过 v2→v3 才能到 v4，所以它是
//    批量迁移器能 0 拒绝的前置条件；缺了会抛 "cannot safely transform unclassified message source"。
//// 用法: node patch-native-code.mjs <target-node_modules>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BS = String.fromCharCode(92);
/** 注入片段（普通代码上下文）。 */
const PATCH_PLAIN = '.replace(/' + BS + 's+/g, " ")';
/** 注入片段（字符串字面量内部，多转义一层）。 */
const PATCH_ESCAPED = '.replace(/' + BS + BS + 's+/g, ' + BS + '" ' + BS + '")';

const NATIVE_PATTERNS = [
  {
    re: /Function\.prototype\.toString\.call\(([^)]*)\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    build: (arg, eq, tmpl) => `Function.prototype.toString.call(${arg})${PATCH_PLAIN}${eq}${tmpl}`,
  },
  {
    re: /intrinsicReflectApply\(intrinsicFunctionToString,\s*([^,)]*),\s*\[\]\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    build: (arg, eq, tmpl) => `intrinsicReflectApply(intrinsicFunctionToString, ${arg}, [])${PATCH_PLAIN}${eq}${tmpl}`,
  },
];

// 注意 `\[[\s\S]{0,400}?` 这一段：7bfbd33 重构时被写成 `\[\[\s\S\]`（多转义了一层括号），
// 那是一个匹配字面量 "[[<空白><非空白>]]" 的正则，对真实代码永远为 false —— 于是「已打过补丁」
// 判定失效、补丁 2 不再幂等（对已打补丁的文件再插一行），unmatched 安全网也一起哑掉。
// tests/patch-native-code.test.mjs 场景 4 现在会拦住这类回归。
export const ALREADY_SOURCE_KINDS = /SOURCE_KINDS\s*=\s*new Set\(\[[\s\S]{0,400}?"instruction-hint"/;

/**
 * 该偏移是否位于一个 JS 字符串/模板字面量内部（只扫描注释、引号与反斜杠转义）。
 * 判断存疑时倾向返回 true：转义比破坏产物安全。
 * @param {string} raw 源码
 * @param {number} offset 目标偏移
 * @returns {boolean} 是否位于字面量内部
 */
function insideStringLiteral(raw, offset) {
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
function escapeForLiteral(text) {
  return text.split(BS).join(BS + BS).split('"').join(BS + '"');
}

/**
 * 只处理一个文件的补丁 1（native-code）。
 * @param {string} raw 源码
 * @returns {{out: string, patched: boolean, already: boolean, brokenRepaired: boolean, literal: boolean}}
 */
function patchNative(raw) {
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

/** 补丁 2：往 v2→v3 的白名单补 "instruction-hint"，打通 v2→v3→v4 整条链（详见文件头）。 */
function patchSourceKinds(raw) {
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
