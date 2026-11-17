// 迁移打点必须同时含上游版本与胶水指纹。
//
// 只记 VERSION 的话，「只改胶水」的修复包能被更新器识别并下载（更新器比的是 VERSION + GLUE），
// 启动期的迁移却会因为 VERSION 没变而跳过 —— 而 profile 的修复（比如那行把 bundle 当插件挂的
// cua-bundle 行）恰恰住在胶水里。两条启动路径都从包根读 GLUE，缺文件时退回纯 VERSION，
// 老包行为不变。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

test('桌面启动期迁移的打点含胶水指纹', () => {
  const source = readFileSync(join(ROOT, 'portable', 'desktop-files', 'dsh-portable-bootstrap.ts'), 'utf8')
  assert.match(source, /function readGlue\(exeDirectory: string\): string/u, 'bootstrap 必须从包根读 GLUE')
  assert.match(source, /const glue = readGlue\(exeDirectory\)/u)
  assert.match(source, /const stamp = glue === '' \? version : `\$\{version\} \$\{glue\}`/u)
  assert.match(source, /if \(readMarkerVersion\(marker\) === stamp\) return false/u)
  assert.match(source, /writeFileSync\(marker, `\$\{stamp\}\\n`\)/u)
})

test('便携启动器迁移的打点含胶水指纹', () => {
  const source = readFileSync(join(ROOT, 'portable', 'dsh-launcher.cs'), 'utf8')
  assert.match(source, /Path\.Combine\(baseDir, "GLUE"\)/u, 'launcher 必须从包根读 GLUE')
  assert.match(source, /string stamp = glue == "" \? version : version \+ " " \+ glue;/u)
  assert.match(source, /if \(!force && ReadMarkerVersion\(doneMarker\) == stamp\)/u)
  assert.match(source, /File\.WriteAllText\(doneMarker, stamp\)/u)
})
