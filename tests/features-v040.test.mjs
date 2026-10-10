import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBlocklist, providerRules, replaceText, rulesFor } from '../lib/index.js'

// 同 match.test.mjs：provider / model 键与规则条目均为编造占位符。

test('模型级匹配：_ 基础 ∪ models 精确/前缀', () => {
  const bl = parseBlocklist(`
global:
  - 'G'
providers:
  example-provider-cn:
    _:
      - 'BASE'
    models:
      'model-a-20260101':
        - 'FLASH'
      'vendor/*':
        - 'DKAI'
`, 1)
  assert.deepEqual(rulesFor(bl, 'example-provider-cn', 'model-a-20260101'), ['G', 'BASE', 'FLASH'])
  assert.deepEqual(rulesFor(bl, 'example-provider-cn', 'Vendor/Model-A'), ['G', 'BASE', 'DKAI'])
  // 模型未命中 → 只基础
  assert.deepEqual(rulesFor(bl, 'example-provider-cn', 'some-other-model'), ['G', 'BASE'])
  // 未给模型 → 只基础
  assert.deepEqual(rulesFor(bl, 'example-provider-cn'), ['G', 'BASE'])
})

test('显式空模型键阻止模型前缀回落', () => {
  const bl = parseBlocklist(`
providers:
  example-provider-cn:
    models:
      'vendor/*': ['DKAI']
      'vendor/model-a': []
`, 1)
  assert.deepEqual(providerRules(bl, 'example-provider-cn', 'vendor/model-a'), [])
})

test('provider 前缀族内按模型取规则', () => {
  const bl = parseBlocklist(`
providers:
  'ex*':
    _: ['V']
    models:
      'model-a-*': ['V4']
`, 1)
  assert.deepEqual(providerRules(bl, 'exampleapi-beijing', 'model-a-pro'), ['V', 'V4'])
  assert.deepEqual(providerRules(bl, 'exampleapi-beijing', 'other'), ['V'])
})

test('正则条目 re: 生效 + 无效正则记警告跳过', () => {
  const bl = parseBlocklist(`
global:
  - 're:机密[0-9]{2,}'
  - 're:[invalid('
  - '明文'
`, 1)
  assert.equal(bl.warnings?.length, 1)
  assert.ok(bl.warnings[0].includes('正则无效'))
  const r = replaceText('机密42和机密1和明文', rulesFor(bl, undefined), '[BLOCKED]')
  assert.equal(r.count, 2)
  assert.equal(r.text, '[BLOCKED]和机密1和[BLOCKED]')
})

test('replaceWith {n} 编号 + hits 明细', () => {
  const r = replaceText('AA BB AA', ['AA', 'BB'], '[BLOCKED:{n}]')
  assert.equal(r.text, '[BLOCKED:1] [BLOCKED:2] [BLOCKED:1]')
  assert.equal(r.count, 3)
  assert.deepEqual(r.hits, [{ n: 1, count: 2 }, { n: 2, count: 1 }])
})

test('默认占位符（无 {n}）不产生 hits', () => {
  const r = replaceText('AA', ['AA'], '[BLOCKED]')
  assert.equal(r.text, '[BLOCKED]')
  assert.equal(r.hits, undefined)
})

test('编号按生效规则顺序（global 在前、当前 provider 在后）', () => {
  const bl = parseBlocklist(`global:\n  - 'G1'\nproviders:\n  deepseek-official:\n    - 'D1'\n`, 1)
  const r = replaceText('G1 D1 G1', rulesFor(bl, 'deepseek-official'), '[B{n}]')
  assert.equal(r.text, '[B1] [B2] [B1]')
  assert.deepEqual(r.hits, [{ n: 1, count: 2 }, { n: 2, count: 1 }])
})

test('旧数组形态经对象化仍等价', () => {
  const bl = parseBlocklist(`providers:\n  deepseek-official:\n    - 'A'\n    - 'B'\n`, 1)
  assert.deepEqual(providerRules(bl, 'deepseek-official'), ['A', 'B'])
  assert.deepEqual(bl.byProvider['deepseek-official'], { base: ['A', 'B'], models: {} })
})
