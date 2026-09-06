// patch-native-code.mjs <target-node_modules>
// 修复上游 deepseek-harness 的一个前端 bug：hasIntrinsicConstructor 用
// Function.prototype.toString 精确比较 native 函数字符串，但真实浏览器
// (Firefox/Chrome) 输出带换行（"function Object() {\n    [native code]\n}"），
// 而 Node.js 输出单行，导致浏览器端 walkJsonValue 把所有普通对象误判为
// "非 lossless JSON"，assistant stream chunk 校验全部失败，消息无法渲染。
//
// 修复方式：比较前用 replace(/\s+/g, " ") 归一化空白（幂等；上游若修复后
// 模式不存在则跳过，不会破坏产物）。
//
// 用法: node patch-native-code.mjs <target-node_modules>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('用法: patch-native-code.mjs <target-node_modules>');
  process.exit(2);
}

// 匹配: Function.prototype.toString.call(ARG) === `function NAME() { [native code] }`
// 以及 intrinsicReflectApply(intrinsicFunctionToString, ARG, []) 变体。
const PATTERNS = [
  // 常规: Function.prototype.toString.call(x) === `...`
  {
    re: /Function\.prototype\.toString\.call\(([^)]*)\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    repl: (m, arg, eq, tmpl) =>
      `Function.prototype.toString.call(${arg}).replace(/\\s+/g, " ")${eq}${tmpl}`,
  },
  // 变体: intrinsicReflectApply(intrinsicFunctionToString, x, []) === `...`
  {
    re: /intrinsicReflectApply\(intrinsicFunctionToString,\s*([^,)]*),\s*\[\]\)(\s*===\s*)(`[^`]*\[native code\][^`]*`)/g,
    repl: (m, arg, eq, tmpl) =>
      `intrinsicReflectApply(intrinsicFunctionToString, ${arg}, []).replace(/\\s+/g, " ")${eq}${tmpl}`,
  },
];

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

let scanned = 0, patched = 0, already = 0;
for await (const file of walk(target)) {
  // 只处理包含 native code 校验的文件，避免全量扫描太慢
  const raw = await readFile(file, 'utf8');
  if (!raw.includes('[native code]')) continue;
  scanned++;
  let out = raw;
  for (const p of PATTERNS) out = out.replace(p.re, p.repl);
  if (out !== raw) {
    await writeFile(file, out, 'utf8');
    patched++;
    console.log(`patched: ${file.slice(target.length)}`);
  } else {
    already++;
  }
}
console.log(`patch-native-code: scanned=${scanned} patched=${patched} already-fixed-or-absent=${already}`);
if (patched === 0 && scanned === 0) {
  // 上游若已修复，native code 模式可能消失；静默通过
  console.log('patch-native-code: no native-code guards found (upstream already fixed?)');
}
