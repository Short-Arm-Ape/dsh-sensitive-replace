// v0.7.5 用例：加硬清洗改成「按请求一次性打标」，并按需向模型交代占位符。
//
// 背景（2026-11-11）：v0.7.3 及以前，一次 400 会开一个 10 分钟的**全局**加硬窗口，
// 期间所有会话的 emoji/符号都被换成可见占位符 [BLOCKED]，模型看到后把它当正文抄进了文档。
//
// 现在的契约：
//   1. 400 → 只给**这一次请求**打标（按 request-error 载荷里的 signal 身份）；
//   2. llm/stream 命中标记才用加硬规则，且**命中即销**（一次性）——不跨会话、不跨步、没有时间窗口；
//   3. 400 响应里没有 error.message（多为请求体被拒）⇒ 不重试，白打没用；
//   4. 真的替换过时，往请求末尾追加**一条**给模型看的说明，讲清占位符不是原文。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, appendReplacementNotice, PLUGIN_VERSION } from '../lib/index.js'

const RULE = 'zq-v074-rule'
const EMOJI = '\u{1F600}\u{1F4A1}'

function fixedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-v074-'))
  return { dir, path: join(dir, 'sensitive-blocklist.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function mount(llm, overrides = {}) {
  const d = fixedDir()
  writeFileSync(d.path, `global:\n  - '${RULE}'\nproviders: {}\n`, 'utf8')
  const handlers = new Map()
  const logs = []
  const tools = []
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
    on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => {} },
    effect: (fn) => fn(),
    get: (name) => (name === 'llm' ? llm : undefined),
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  apply(ctx, {
    enabled: true,
    autoReplace: true,
    dispatchScrub: true,
    detectUnfiltered: false,
    recoverOn400: true,
    maxRecoveries: 2,
    stripEmojiOn400: true,
    blocklistPath: d.path,
    replaceWith: '[BLOCKED]',
    ...overrides,
  })
  return {
    d,
    logs,
    first: (name) => {
      const list = handlers.get(name)
      assert.ok(list && list.length > 0, '没有注册监听器: ' + name)
      return list[0]
    },
    tool: (name) => {
      const t = tools.find((x) => x.name === name)
      assert.ok(t, '没有注册工具: ' + name)
      return t
    },
  }
}

function stub(calls) {
  return { adapterStream: (o) => { calls.push(o); return (async function* () {})() } }
}

const userMessage = (text, id = 'm1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const fail400 = (signal, message = 'Content Exists Risk') => ({ failure: { status: 400, code: 'INVALID_REQUEST', message }, signal })

test('打标只作用于同一个 signal 的那一次重试，且是一次性的', async () => {
  const calls = []
  const f = mount(stub(calls))
  const SIG = { aborted: false }
  try {
    assert.deepEqual(await f.first('agent/request-error')(fail400(SIG), async () => undefined), { kind: 'retry' })
    assert.equal((await f.tool('sensitive_replace_status').execute({})).armedRetries, 1)

    const options = { provider: 'deepseek-official', model: 'm', signal: SIG, messages: [userMessage(`含 ${EMOJI} 的文本`)] }
    f.first('llm/stream')(options, () => { throw new Error('被打标的请求应当改写后重发') })
    assert.equal(calls.length, 1, '命中标记 → 走 adapterStream')
    assert.equal(calls[0].messages[0].content[0].text, '含 [BLOCKED] 的文本')
    assert.equal((await f.tool('sensitive_replace_status').execute({})).armedRetries, 0, '命中即销')

    // 同一个 signal 再来一次（比如重试又失败后的下一步）：标记已销，不再加硬
    let nexted = false
    const again = { provider: 'deepseek-official', model: 'm', signal: SIG, messages: [userMessage(`再来 ${EMOJI}`)] }
    f.first('llm/stream')(again, () => { nexted = true })
    assert.equal(nexted, true, '第二次不应再改写')
    assert.equal(again.messages[0].content[0].text, `再来 ${EMOJI}`)
  } finally {
    f.d.cleanup()
  }
})

test('跨会话隔离：A 会话被打标，B 会话的请求一个字节都不变', async () => {
  const calls = []
  const f = mount(stub(calls))
  const SIG_A = { aborted: false }
  const SIG_B = { aborted: false }
  try {
    await f.first('agent/request-error')(fail400(SIG_A), async () => undefined)
    const other = { provider: 'deepseek-official', model: 'm', signal: SIG_B, messages: [userMessage(`B 的 ${EMOJI}`)] }
    const before = JSON.stringify(other)
    let nexted = false
    f.first('llm/stream')(other, () => { nexted = true })
    assert.equal(nexted, true)
    assert.equal(calls.length, 0, 'B 会话不该被重发')
    assert.equal(JSON.stringify(other), before)
  } finally {
    f.d.cleanup()
  }
})

test('400 没有 error.message（请求体被拒）→ 不重试、不打标', async () => {
  const f = mount(stub([]))
  try {
    assert.equal(await f.first('agent/request-error')(fail400({ aborted: false }, ''), async () => undefined), undefined)
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(s.armedRetries, 0)
    assert.equal(s.recoveries, 0, '不该记成一次成功恢复')
    assert.equal(s.last400, 'INVALID_REQUEST', '读数仍要记下')
  } finally {
    f.d.cleanup()
  }
})

test('400 载荷里没有 signal → 不重试（打不了标就别乱剥）', async () => {
  const f = mount(stub([]))
  try {
    assert.equal(await f.first('agent/request-error')({ failure: { status: 400, code: 'INVALID_REQUEST', message: 'Content Exists Risk' } }, async () => undefined), undefined)
    assert.equal((await f.tool('sensitive_replace_status').execute({})).armedRetries, 0)
  } finally {
    f.d.cleanup()
  }
})

test('替换发生时追加一条给模型看的说明：讲清占位符不是原文、别照抄', async () => {
  const calls = []
  const f = mount(stub(calls))
  try {
    const options = { provider: 'deepseek-official', model: 'm', messages: [userMessage(`含 ${RULE} 的文本`)] }
    f.first('llm/stream')(options, () => { throw new Error('应当改写后重发') })
    assert.equal(calls.length, 1)
    const sent = calls[0]
    assert.equal(sent.messages.length, 2, '原消息 + 一条说明')
    const note = sent.messages[1]
    assert.equal(note.role, 'user')
    assert.equal(note.source.kind, 'dsh-sensitive-replace')
    const text = note.content[0].text
    assert.ok(text.includes('1 处'), '要带处数，实际: ' + text)
    assert.ok(text.includes('[BLOCKED]'), '要点名占位符，实际: ' + text)
    assert.ok(text.includes('不要把占位符当正文抄进去'), '要直接说别照抄，实际: ' + text)
    assert.equal(text.includes(RULE), false, '说明里不许出现被屏蔽的原文')
  } finally {
    f.d.cleanup()
  }
})

test('说明：没有替换就不追加；notifyReplaced=false 也不追加', async () => {
  const calls = []
  const f = mount(stub(calls))
  try {
    const clean = { provider: 'deepseek-official', model: 'm', messages: [userMessage('完全干净的文本')] }
    let nexted = false
    f.first('llm/stream')(clean, () => { nexted = true })
    assert.equal(nexted, true)
    assert.equal(calls.length, 0)
  } finally {
    f.d.cleanup()
  }

  const calls2 = []
  const f2 = mount(stub(calls2), { notifyReplaced: false })
  try {
    const options = { provider: 'deepseek-official', model: 'm', messages: [userMessage(`含 ${RULE} 的文本`)] }
    f2.first('llm/stream')(options, () => { throw new Error('应当改写后重发') })
    assert.equal(calls2.length, 1)
    assert.equal(calls2[0].messages.length, 1, '关掉说明后只留原消息')
  } finally {
    f2.d.cleanup()
  }
})

test('纯函数 appendReplacementNotice：count=0 原样返回；冻结且不改入参', () => {
  const options = Object.freeze({ provider: 'p', model: 'm', messages: Object.freeze([userMessage('x')]) })
  assert.equal(appendReplacementNotice(options, 0, '[BLOCKED]'), options)
  const out = appendReplacementNotice(options, 2, '[BLOCKED]')
  assert.equal(options.messages.length, 1, '入参不许被改')
  assert.equal(out.messages.length, 2)
  assert.equal(Object.isFrozen(out), true)
  assert.ok(out.messages[1].content[0].text.includes('2 处'))
})

test('状态行：报 stripEmojiOn400 / notifyReplaced / armedRetries，版本 0.7.5', async () => {
  const f = mount(stub([]))
  try {
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(PLUGIN_VERSION, '0.7.5')
    assert.equal(s.version, '0.7.5')
    assert.equal(s.stripEmojiOn400, true)
    assert.equal(s.notifyReplaced, true)
    assert.equal(s.armedRetries, 0)
    assert.equal(s.aggressive, false)
    const text = f.tool('sensitive_replace_status').output.render({}, s)[0].text
    assert.ok(/规则 全局\d+\/来源\d+ 组/.test(text))
  } finally {
    f.d.cleanup()
  }
})
