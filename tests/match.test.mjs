import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBlocklist, providerRules, replaceText, rulesFor } from '../lib/index.js'

// 本文件里的 provider 键、model 键与规则条目**全部是编造的占位符**，
// 不含任何真实屏蔽表内容 —— 真实屏蔽表只存在于使用者本机的
// $DSH_HOME/sensitive-blocklist.yaml，从不进入本仓库。

test('按 Provider ID 精确匹配（全局 ∪ 专属）', () => {
  const bl = parseBlocklist(`
global:
  - 'A'
providers:
  deepseek-official:
    - 'B'
  example-provider-cn:
    - 'C'
`, 1)
  assert.deepEqual(rulesFor(bl, 'deepseek-official'), ['A', 'B'])
  assert.deepEqual(rulesFor(bl, 'example-provider-cn'), ['A', 'C'])
})

test('旧键名（厂商名/来源名）不再命中 —— 匹配模式改按 Provider ID', () => {
  const bl = parseBlocklist(`providers:\n  deepseek:\n    - 'B'\n  example-vendor:\n    - 'C'\n`, 1)
  assert.deepEqual(rulesFor(bl, 'deepseek-official'), [])
  assert.deepEqual(rulesFor(bl, 'example-provider-cn'), [])
  assert.deepEqual(rulesFor(bl, 'exampleapi-beijing'), [])
})

test('前缀模式（键尾 *）与最长前缀优先', () => {
  const bl = parseBlocklist(`
providers:
  'ex*':
    - 'V'
  'exampleapi-*':
    - 'VE'
  example-provider-cn:
    - 'A'
`, 1)
  assert.deepEqual(providerRules(bl, 'exampleapi-beijing'), ['VE'])
  assert.deepEqual(providerRules(bl, 'example-other'), ['V'])
  assert.deepEqual(providerRules(bl, 'ex'), ['V'])
  // 精确键优先于前缀模式
  assert.deepEqual(providerRules(bl, 'example-provider-cn'), ['A'])
})

test('显式空列表的精确键阻止前缀回落', () => {
  const bl = parseBlocklist(`providers:\n  'ex*':\n    - 'V'\n  exampleapi-beijing: []\n`, 1)
  assert.deepEqual(providerRules(bl, 'exampleapi-beijing'), [])
})

test('大小写不敏感（键与请求 id 均归一为小写）', () => {
  const bl = parseBlocklist(`providers:\n  DEEPSEEK-OFFICIAL:\n    - 'B'\n`, 1)
  assert.deepEqual(rulesFor(bl, 'DeepSeek-Official'), ['B'])
})

test('provider 缺省只套 global', () => {
  const bl = parseBlocklist(`global:\n  - 'A'\nproviders:\n  deepseek-official:\n    - 'B'\n`, 1)
  assert.deepEqual(rulesFor(bl, undefined), ['A'])
})

test('YAML 锚点：两条路由共用同一份规则；码位转义写法照常解码', () => {
  const bl = parseBlocklist(`
global:
providers:
  deepseek-official:
    - '\\u{1F600}'
  example-provider-cn: &shared
    - 'ZQPROVIDERZQ'
  exampleapi-beijing: *shared
`, 1)
  assert.ok(rulesFor(bl, 'deepseek-official').includes('\u{1F600}'))
  assert.deepEqual(providerRules(bl, 'example-provider-cn'), ['ZQPROVIDERZQ'])
  assert.deepEqual(providerRules(bl, 'exampleapi-beijing'), ['ZQPROVIDERZQ'])
})

test('清洗端到端：指定来源命中专属规则', () => {
  const bl = parseBlocklist(`
providers:
  example-provider-cn:
    - 'ZQPROVIDERZQ'
`, 1)
  const r = replaceText('提到ZQPROVIDERZQ', rulesFor(bl, 'example-provider-cn'), '[BLOCKED]')
  assert.equal(r.count, 1)
  assert.equal(r.text, '提到[BLOCKED]')
})
