// v0.7.5 用例：出网前把「孤立代理项」修掉，否则 provider 会把整条请求判成非法 JSON。
//
// 2026-11-11 抓包实证：provider 回包
//   Failed to parse the request body as JSON:
//   messages[13].content[5].input.aliases[2]: unexpected end of hex escape
// 定位到唯一一处 U+D83D（模型写 `remember` 参数时把 `\ud83d` 当成 6 个字符写，JSON 一解码成了半个代理对）。
// 这类毒**永远命中不了屏蔽词规则**（文本上看完全合法），只能在最后一个能改字节的位置修。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, fixLoneSurrogates, toWellFormedString } from '../lib/index.js'

const LONE = '\uD83D' // 孤立高位代理（不是 emoji，emoji 是 D83D DE00 这对）
const REPLACEMENT = '\uFFFD'

function fixedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-v075-'))
  return { dir, path: join(dir, 'sensitive-blocklist.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function mount(llm, overrides = {}) {
  const d = fixedDir()
  writeFileSync(d.path, 'global: []\nproviders: {}\n', 'utf8')
  const handlers = new Map()
  const logs = []
  const tools = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) }),
    on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => {} },
    effect: (fn) => fn(),
    get: (name) => (name === 'llm' ? llm : undefined),
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  apply(ctx, {
    enabled: true, autoReplace: true, dispatchScrub: true, detectUnfiltered: false,
    recoverOn400: true, blocklistPath: d.path, replaceWith: '[BLOCKED]', ...overrides,
  })
  return {
    d, logs,
    first: (n) => { const l = handlers.get(n); assert.ok(l && l.length > 0, '没有监听器 ' + n); return l[0] },
    tool: (n) => { const t = tools.find((x) => x.name === n); assert.ok(t, '没有工具 ' + n); return t },
  }
}

/** 扫一遍值里还有没有孤立代理项 */
function countLone(value) {
  let n = 0
  const walk = (o) => {
    if (typeof o === 'string') {
      for (let i = 0; i < o.length; i++) {
        const c = o.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) { const x = o.charCodeAt(i + 1); if (!(x >= 0xdc00 && x <= 0xdfff)) n++ }
        else if (c >= 0xdc00 && c <= 0xdfff) { const p = o.charCodeAt(i - 1); if (!(p >= 0xd800 && p <= 0xdbff)) n++ }
      }
      return
    }
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') Object.values(o).forEach(walk)
  }
  walk(value)
  return n
}

const toolCallMessage = (args) => ({
  id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'tool-call', id: 'c1', name: 'remember', arguments: args }],
})
const userMessage = (text) => ({ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

test('toWellFormedString：孤立高位 / 低位 / 合法代理对 / 干净串', () => {
  assert.equal(toWellFormedString('裸 ' + LONE), '裸 ' + REPLACEMENT)
  assert.equal(toWellFormedString('尾 ' + '\uDE00'), '尾 ' + REPLACEMENT)
  const pair = '\uD83D\uDE00'
  assert.equal(toWellFormedString('emoji ' + pair), 'emoji ' + pair, '合法代理对不许动')
  const clean = '普通中文 abc'
  assert.equal(toWellFormedString(clean), clean)
})

test('fixLoneSurrogates：tool-call 参数里 parse 之后才现形的孤立代理，被修掉且仍是合法 JSON', () => {
  // 模型当初写下的 args 文本：`\ud83d` 是**六个字符**的转义文本，文本层完全合法，
  // 只有 JSON.parse 之后才变成一个孤立高位代理 —— 这正是屏蔽词规则永远拦不到它的原因。
  const poisoned = '{"aliases":["孤立代理项","裸 \\ud83d"]}'
  assert.equal(countLone(poisoned), 0, '文本层不许有孤立代理（否则就不是实测那个形态了）')
  assert.equal(countLone(JSON.parse(poisoned)), 1, '前提：parse 之后确实有毒')
  const options = { provider: 'p', model: 'm', messages: [toolCallMessage(poisoned)] }

  const r = fixLoneSurrogates(options)
  assert.equal(r.count, 1)
  assert.notEqual(r.options, options, '有命中要返回新对象')
  const args = r.options.messages[0].content[0].arguments
  const reparsed = JSON.parse(args) // 必须仍是合法 JSON
  assert.equal(countLone(reparsed), 0, '修完不许再有孤立代理：' + JSON.stringify(reparsed))
  assert.equal(reparsed.aliases[1], '裸 ' + REPLACEMENT)
  assert.equal(options.messages[0].content[0].arguments, poisoned, '入参不许被改')
})

test('fixLoneSurrogates：普通文本块 / 嵌套 tool-result / system 都覆盖；没毒时零拷贝', () => {
  const options = {
    provider: 'p', model: 'm', system: 'sys ' + LONE,
    messages: [{
      id: 'm3', role: 'user', source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '结果 ' + LONE }] }],
    }],
  }
  const r = fixLoneSurrogates(options)
  assert.equal(r.count, 2, 'system + tool-result 文本')
  assert.equal(countLone(r.options), 0)
  assert.equal(Object.isFrozen(r.options), true)

  const clean = { provider: 'p', model: 'm', messages: [userMessage('干净')] }
  const same = fixLoneSurrogates(clean)
  assert.equal(same.options, clean, '没毒要返回原引用')
  assert.equal(same.count, 0)
})

test('llm/stream：有毒的请求会被修好再送给适配器，并记一条 warn', () => {
  const sent = []
  const llm = { adapterStream: (o) => { sent.push(o); return (async function* () {})() } }
  const poisoned = '{"q":"裸 \\ud83d"}'
  const f = mount(llm)
  try {
    const options = { provider: 'deepseek-official', model: 'm', messages: [toolCallMessage(poisoned)] }
    f.first('llm/stream')(options, () => { throw new Error('应当改写后重发') })
    assert.equal(sent.length, 1)
    assert.equal(countLone(JSON.parse(sent[0].messages[0].content[0].arguments)), 0)
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('孤立代理')))
    const s = f.tool('sensitive_replace_status').execute({})
    return s.then((v) => {
      assert.equal(v.fixLoneSurrogates, true)
      assert.equal(v.wellFormedFixes, 1)
    })
  } finally {
    f.d.cleanup()
  }
})

test('llm/stream：干净的请求一个字节都不动（仍然 next()）', () => {
  const sent = []
  const f = mount({ adapterStream: (o) => { sent.push(o); return (async function* () {})() } })
  try {
    const options = { provider: 'deepseek-official', model: 'm', messages: [userMessage('干净')] }
    const before = JSON.stringify(options)
    let nexted = false
    f.first('llm/stream')(options, () => { nexted = true })
    assert.equal(nexted, true)
    assert.equal(sent.length, 0)
    assert.equal(JSON.stringify(options), before)
  } finally {
    f.d.cleanup()
  }
})

test('fixLoneSurrogates=false 时不管（保留开关）', () => {
  const sent = []
  const f = mount({ adapterStream: (o) => { sent.push(o); return (async function* () {})() } }, { fixLoneSurrogates: false })
  try {
    const options = { provider: 'deepseek-official', model: 'm', messages: [toolCallMessage('{"q":"裸 ' + LONE + '"}')] }
    let nexted = false
    f.first('llm/stream')(options, () => { nexted = true })
    assert.equal(nexted, true)
    assert.equal(sent.length, 0)
  } finally {
    f.d.cleanup()
  }
})
