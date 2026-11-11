// v0.7.3 用例（保留部分）：emoji 不再被顺手剥掉。
//
// 背景（2026-11-11 用户报告）：写文档时 emoji 被换成 [BLOCKED]。
// v0.7.3 把「400 之后剥 emoji」改成显式开关；v0.7.4 又把开关语义收紧成「只作用于那一次重试」，
// 相关用例移到 v074.test.mjs。这里只留「默认不剥 / 默认不重试」这一层。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, scrubRequest, replaceText, Config } from '../lib/index.js'

function fixedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-v073-'))
  return { dir, path: join(dir, 'sensitive-blocklist.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeCtx() {
  const tools = []
  const handlers = new Map()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => {} },
    effect: (fn) => fn(),
    get: () => undefined,
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, tools, handlers }
}

function mount(path, overrides = {}) {
  const f = fakeCtx()
  writeFileSync(path, 'global: []\nproviders: {}\n', 'utf8')
  apply(f.ctx, { enabled: true, autoReplace: true, blocklistPath: path, replaceWith: '[BLOCKED]', ...overrides })
  return f
}

const EMOJI = '\u{1F600}\u{1F4A1}\u{2705}\u{26A0}'

function msg(text) {
  return [{ id: 'm1', role: 'user', content: [{ type: 'text', text }] }]
}

test('配置默认：stripEmojiOn400 关，aggressive 也关', () => {
  const c = Config({})
  assert.equal(c.stripEmojiOn400, false)
  assert.equal(c.aggressive, false)
})

test('出网清洗：没开 stripEmojiOn400 时，即使 aggressive=true 也不剥 emoji', () => {
  const d = fixedDir()
  try {
    const f = mount(d.path, { dispatchScrub: true, detectUnfiltered: false, aggressive: true })
    const stream = f.handlers.get('llm/stream')[0]
    const text = `普通中文 ${EMOJI} 结束`
    const options = { provider: 'deepseek-official', model: 'm', messages: msg(text) }
    let next = 0
    f.ctx.get = () => ({ adapterStream: () => { throw new Error('不该重发') } })
    stream(options, () => { next += 1 })
    assert.equal(next, 1, '应当直接放行（拿不到规则就不改写）')
  } finally {
    d.cleanup()
  }
})

test('400 钩子：stripEmojiOn400 关着时不重试（同一份请求只会再吃一次同样的 400）', async () => {
  const d = fixedDir()
  try {
    const f = mount(d.path, { recoverOn400: true })
    const hook = f.handlers.get('agent/request-error')[0]
    let next = 0
    const out = await hook({ turn: 1, step: 1, provider: 'deepseek-official', failure: { status: 400, code: 'INVALID_REQUEST', message: 'DeepSeek Messages request failed (400)' }, signal: { aborted: false } }, async () => { next += 1 })
    assert.equal(next, 1)
    assert.equal(out, undefined, '不应当返回 retry')
  } finally {
    d.cleanup()
  }
})

test('纯函数：没有 emoji 规则时 scrubRequest 一个字符都不动（emoji 原样），带规则才替换', () => {
  const text = `保留 ${EMOJI}`
  const untouched = scrubRequest({ provider: 'p', model: 'm', messages: msg(text) }, ['zq-v073-probe'], '[BLOCKED]')
  assert.equal(untouched.count, 0)
  assert.equal(untouched.options.messages[0].content[0].text, text)

  const rule = 're:[\u{1F000}-\u{1FAFF}]+'
  const hit = replaceText(text, [rule], '[BLOCKED]')
  assert.equal(hit.count, 1)
  assert.equal(hit.text, '保留 [BLOCKED]\u{2705}\u{26A0}')
})
