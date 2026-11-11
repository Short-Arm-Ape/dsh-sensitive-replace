// 包元数据契约：插件列表里显示的名字/简介/图标都来自包清单与 locale 导出，写坏了就静默退回技术名。
//
// DSH 的读取路径（`@deepseek-ai/dsh-app-boot` 的 readPluginMeta）：
//   - 标题/简介：`exports["./locale/*.json"]` 之下**必须**有 en.json；同目录其它 `<lang>.json` 按文件名当语言 id，
//     每个文件读 `meta.title` / `meta.description`；缺的字段回落到 package.json 的 name / description。
//   - 图标：package.json 顶层 `icon`（相对本包、必须留在包内、SVG/PNG/JPEG/WebP、≤256 KiB），
//     或以 `<包名>/icon` 导出的资源。这里用前者。
// 2026-11-11 实测：加之前标题就是 `dsh-sensitive-replace`、简介是那串很长的 npm description、没有图标。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_VERSION } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('图标：package.json 声明了 icon.svg，文件在包内、是 SVG、不超过 256 KiB', () => {
  assert.equal(pkg.icon, 'icon.svg')
  const full = join(ROOT, pkg.icon)
  const size = statSync(full).size
  assert.ok(size > 0 && size <= 256 * 1024, '图标大小必须在 1 B .. 256 KiB，实际 ' + size)
  const text = readFileSync(full, 'utf8')
  assert.ok(text.trimStart().startsWith('<svg'), '必须是 SVG 文本')
  // xmlns 是命名空间声明（不是外部引用），真正的风险是 href / url() 指向外面
  assert.equal(/href\s*=|url\(\s*['"]?https?:|<image\b/i.test(text), false, 'SVG 不许引用外部资源')
  assert.ok(pkg.files.includes('icon.svg'), 'files 里要带上图标，否则 npm 包缺文件')
})

test('多语言：locale/*.json 通过 exports 暴露，en 必在，每个文件都要有 meta.title 与 meta.description', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json', '不给这个导出，loader 解析不到 locale')
  assert.ok(pkg.files.includes('locale'), 'files 里要带上 locale 目录')
  for (const lang of ['en', 'zh']) {
    const file = join(ROOT, 'locale', lang + '.json')
    const dict = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof dict.meta?.title, 'string')
    assert.ok(dict.meta.title.trim().length > 0, lang + ' 的 title 不能为空')
    assert.equal(typeof dict.meta?.description, 'string')
    assert.ok(dict.meta.description.trim().length > 0, lang + ' 的 description 不能为空')
  }
})

test('版本对齐：package.json / PLUGIN_VERSION / 类型声明三处同号', () => {
  assert.equal(pkg.version, PLUGIN_VERSION)
  const types = readFileSync(join(ROOT, 'lib/types/index.d.ts'), 'utf8')
  assert.ok(types.includes('PLUGIN_VERSION = "' + PLUGIN_VERSION + '"'),
    'lib/types/index.d.ts 里的 PLUGIN_VERSION 也要同步')
})
