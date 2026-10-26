// restore-ignored.mjs <modules-dir>
//
// pnpm 11.28 起，`pnpm install`/`pnpm deploy` 收尾时会把「不在依赖树里、pnpm 也没有安装记录」
// 的目录从 node_modules 搬进 node_modules/.ignored 隔离起来（日志：
// `Moving <pkg> to "node_modules/.ignored/<pkg>". It is not in the dependency tree and pnpm
// has no record of installing it.`）。11.27 没有这个动作 —— 所以同一份脚本、同一份上游源码，
// 换个 pnpm 小版本就能让随包内容凭空少掉一大块。
//
// 这里必须还原：assemble-runtime.ps1 的 deploy 只认 `@deepseek-ai/dsh` 那棵子树，它判定
// 「无关」的 1170 个包里有 @trycua/cua-driver、@ubjs/*、chrome-devtools-mcp、@babel/code-frame、
// @standard-schema/spec —— 全是后面几步要从根 node_modules 复制进 portable/app 的东西。
// 被搬走之后 patch-dep 只会打印「缺失于 root，跳过」，随包少了 Cua Driver SDK、
// assert-shipped 才在最后一步报错。还原之后，根 node_modules 回到 install 结束时的样子，
// 后续步骤与 pnpm 11.27 时的行为一致。
//
// 用法: node restore-ignored.mjs <modules-dir>
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** 判断 .ignored 下的某个条目是包名还是 scope 目录。 */
function isScope(name) {
  return name.startsWith('@');
}

/**
 * 把 node_modules/.ignored 里被隔离的包搬回 node_modules。
 * 只按原名还原：pnpm 在目标名已被占用时会退到 `name_1`、`name_2`，那种名字还原回哪个位置
 * 无法可靠推断，一律保留并报告，交给人看一眼 —— 比猜错位置、把两个不同版本混在一起安全。
 * @param {string} modulesDir - 被 deploy 整理过的那份 node_modules。
 * @returns {{ restored: string[], kept: string[] }} 还原与保留的包名（相对 modulesDir）。
 */
export function restoreIgnored(modulesDir) {
  const ignoredDir = join(modulesDir, '.ignored');
  const restored = [];
  const kept = [];
  if (!existsSync(ignoredDir)) return { restored, kept };

  const entries = [];
  for (const name of readdirSync(ignoredDir)) {
    if (isScope(name)) {
      const scopeDir = join(ignoredDir, name);
      if (!statSync(scopeDir).isDirectory()) continue;
      for (const inner of readdirSync(scopeDir)) {
        if (!statSync(join(scopeDir, inner)).isDirectory()) continue;
        entries.push([name, inner]);
      }
    } else {
      entries.push([null, name]);
    }
  }

  for (const [scope, name] of entries) {
    const parts = scope === null ? [name] : [scope, name];
    const label = parts.join('/');
    const destination = join(modulesDir, ...parts);
    if (existsSync(destination)) { kept.push(label); continue; }
    mkdirSync(dirname(destination), { recursive: true });
    try {
      renameSync(join(ignoredDir, ...parts), destination);
      restored.push(label);
    } catch (error) {
      console.warn(`[restore] ${label} 还原失败，保留在 .ignored：${String(error)}`);
      kept.push(label);
    }
  }
  return { restored, kept };
}

if (import.meta.main) {
  const modulesDir = process.argv[2];
  if (modulesDir === undefined) {
    console.error('用法: node restore-ignored.mjs <modules-dir>');
    process.exit(2);
  }
  const { restored, kept } = restoreIgnored(modulesDir);
  console.log(`[restore] 还原 ${restored.length} 个包${restored.length > 0 ? `（${relative(process.cwd(), modulesDir)}）` : ''}`);
  if (kept.length > 0) {
    console.warn(`[restore] ${kept.length} 个包未还原（目标位置已有同名目录）：${kept.slice(0, 10).join(', ')}${kept.length > 10 ? ' …' : ''}`);
  }
}
