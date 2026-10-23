// v0.7.2 用例：sensitive_replace_status 的那行中文（render）要能看出屏蔽表在不在。
// 背景：0.7.1 只把 blocklistExists 放进了结构化输出，render 没打印 ⇒ 看工具结果分不清"表是空的"和"表没读到"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, PLUGIN_VERSION } from '../lib/index.js'

function fixedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-v072-'))
  return { dir, path: join(dir, 'sensitive-blocklist.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeCtx() {
  const tools = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    on: () => {},
    effect: (fn) => fn(),
    get: () => undefined,
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, tools }
}

function mount(path, overrides = {}) {
  const f = fakeCtx()
  apply(f.ctx, { enabled: true, autoReplace: true, blocklistPath: path, replaceWith: '[BLOCKED]', ...overrides })
  return {
    ...f,
    status: () => f.tools.find((x) => x.name === 'sensitive_replace_status'),
  }
}

test('render：屏蔽表存在 → 行里写「屏蔽表 存在」，且不出现「缺失」', async () => {
  const d = fixedDir()
  try {
    writeFileSync(d.path, 'global: []\nproviders: {}\n', 'utf8')
    const f = mount(d.path)
    const value = await f.status().execute({})
    assert.equal(value.blocklistExists, true)
    const text = f.status().output.render({}, value)[0].text
    assert.ok(text.includes('屏蔽表 存在'), '要能看到「屏蔽表 存在」，实际: ' + text)
    assert.equal(text.includes('缺失'), false)
  } finally {
    d.cleanup()
  }
})

test('render：屏蔽表不存在（关闭自动建表）→ 行里写「屏蔽表 缺失」', async () => {
  const d = fixedDir()
  try {
    const f = mount(d.path, { createBlocklistIfMissing: false })
    const value = await f.status().execute({})
    assert.equal(value.blocklistExists, false)
    const text = f.status().output.render({}, value)[0].text
    assert.ok(text.includes('屏蔽表 缺失'), '要能看到「屏蔽表 缺失」，实际: ' + text)
  } finally {
    d.cleanup()
  }
})

test('render 仍然保留规则数，结构字段 blocklistExists 仍是布尔', async () => {
  const d = fixedDir()
  try {
    writeFileSync(d.path, 'global:\n  - zq-v072-probe\nproviders: {}\n', 'utf8')
    const f = mount(d.path)
    const value = await f.status().execute({})
    assert.equal(typeof value.blocklistExists, 'boolean')
    const text = f.status().output.render({}, value)[0].text
    assert.ok(/规则 全局\d+\/来源\d+ 组/.test(text), '规则数那一段要还在，实际: ' + text)
  } finally {
    d.cleanup()
  }
})

test('版本号对齐：PLUGIN_VERSION 是 0.7.2，状态里也报这个版本', async () => {
  const d = fixedDir()
  try {
    writeFileSync(d.path, 'global: []\nproviders: {}\n', 'utf8')
    const f = mount(d.path)
    assert.equal(PLUGIN_VERSION, '0.7.2')
    const value = await f.status().execute({})
    assert.equal(value.version, '0.7.2')
    assert.ok(f.status().output.render({}, value)[0].text.startsWith('dsh-sensitive-replace v0.7.2：'))
  } finally {
    d.cleanup()
  }
})
