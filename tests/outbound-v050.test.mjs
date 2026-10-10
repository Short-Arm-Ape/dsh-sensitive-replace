// v0.5.0 出网前清洗（dispatchScrub）与 400 自动恢复（recoverOn400）用例。
// 关键点：清理的是**整份请求**（含历史消息、tool-call 参数、模型自己写过的内容），
// 且不重进 llm/stream 瀑布（不打扰其它监听器）；400 时切加硬清洗并重试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, scrubRequest } from '../lib/index.js'

const RULE = 'x1z-outbound-demo'
const EMOJI = '\u{1F600}'

function blocklistDoc(rules = [RULE]) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-out-'))
  const path = join(dir, 'sensitive-blocklist.yaml')
  writeFileSync(path, `global:\n${rules.map((r) => `  - '${r}'\n`).join('')}`)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeCtx(llm) {
  const handlers = new Map()
  const logs = []
  const tools = []
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
    },
    effect: (fn) => fn(),
    get: (name) => (name === 'llm' ? llm : undefined),
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, handlers, logs, tools }
}

function mount(path, llm, overrides = {}) {
  const f = fakeCtx(llm)
  apply(f.ctx, {
    enabled: true,
    autoReplace: true,
    dispatchScrub: true,
    detectUnfiltered: true,
    recoverOn400: true,
    aggressiveMs: 600000,
    maxRecoveries: 2,
    blocklistPath: path,
    replaceWith: '[BLOCKED]',
    ...overrides,
  })
  return {
    ...f,
    first(name) {
      const list = f.handlers.get(name)
      assert.ok(list && list.length > 0, `没有注册监听器: ${name}`)
      return list[0]
    },
    tool(name) {
      const t = f.tools.find((x) => x.name === name)
      assert.ok(t, `没有注册工具: ${name}`)
      return t
    },
  }
}

function llmStub(calls) {
  const empty = () => (async function* () {})()
  return {
    stream: (o) => { calls.push(['stream', o]); return empty() },
    adapterStream: (o, prepared) => { calls.push(['adapterStream', prepared, o]); return empty() },
  }
}

const userMessage = (text, id = 'm1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const toolCallMessage = (args, id = 'm2') => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: args }],
})

test('scrubRequest：整份请求清洗（text / reasoning / tool-result / tool-call 参数），不动原对象、保留消息 id', () => {
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: `系统提示含 ${RULE}`,
    messages: [
      userMessage(`历史消息含 ${RULE}`),
      toolCallMessage(`{"command":"echo ${RULE}"}`),
      {
        id: 'm3',
        role: 'user',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: `工具结果含 ${RULE}` }] }],
      },
      { id: 'm4', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: `推理含 ${RULE}` }] },
    ],
  }
  const before = JSON.stringify(options)
  const r = scrubRequest(options, [RULE], '[BLOCKED]')
  assert.equal(r.count, 5, 'text + tool-call + tool-result + reasoning + system 各 1 处')
  assert.equal(r.options.system, '系统提示含 [BLOCKED]')
  assert.equal(r.options.messages[0].content[0].text, '历史消息含 [BLOCKED]')
  assert.equal(r.options.messages[2].content[0].content[0].text, '工具结果含 [BLOCKED]')
  assert.equal(r.options.messages[3].content[0].text, '推理含 [BLOCKED]')
  assert.equal(JSON.parse(r.options.messages[1].content[0].arguments).command, 'echo [BLOCKED]')
  assert.equal(r.options.messages[1].id, 'm2', '消息身份保留')
  assert.equal(JSON.stringify(options), before, '原请求（深冻结对象）不得被改写')
  assert.equal(r.options.provider, 'deepseek-official')
})

test('scrubRequest：tool-call 参数替换后仍是合法 JSON（占位符含引号也不会弄坏）', () => {
  const options = { provider: 'p', model: 'm', messages: [toolCallMessage(`{"command":"echo ${RULE}"}`)] }
  const r = scrubRequest(options, [RULE], 'say "hi"')
  const args = r.options.messages[0].content[0].arguments
  assert.doesNotThrow(() => JSON.parse(args))
  assert.equal(JSON.parse(args).command, 'echo say "hi"')
})

test('scrubRequest：无命中时返回同一个对象（不制造无谓改动）', () => {
  const options = { provider: 'p', model: 'm', messages: [userMessage('clean')] }
  const r = scrubRequest(options, [RULE], '[BLOCKED]')
  assert.equal(r.count, 0)
  assert.equal(r.options, options)
})

test('llm/stream：命中时深拷贝后直接续到适配器边界，不调用 next、不重进瀑布', async () => {
  const doc = blocklistDoc()
  try {
    const calls = []
    const f = mount(doc.path, llmStub(calls))
    const options = { provider: 'deepseek-official', model: 'deepseek-flash', messages: [userMessage(`含 ${RULE}`)] }
    let nexted = false
    f.first('llm/stream')(options, () => { nexted = true; return (async function* () {})() })
    assert.equal(nexted, false, '必须接管请求')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'adapterStream')
    assert.equal(calls[0][1], undefined, 'prepared 传 undefined，由适配器边界自行准备')
    assert.equal(calls[0][2].messages[0].content[0].text, '含 [BLOCKED]')
    assert.equal(options.messages[0].content[0].text, `含 ${RULE}`, '原请求未被改动')

    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(s.dispatchScrubs, 1)
    assert.equal(s.dispatchLast, 1)
    assert.equal(s.dispatchCharges, 1)
    assert.equal(s.aggressive, false)
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('请求出网前替换 1 处')))
  } finally {
    doc.cleanup()
  }
})

test('llm/stream：无命中时原样 next()，不碰适配器', () => {
  const doc = blocklistDoc()
  try {
    const calls = []
    const f = mount(doc.path, llmStub(calls))
    const options = { provider: 'deepseek-official', model: 'deepseek-flash', messages: [userMessage('clean')] }
    let nexted = false
    f.first('llm/stream')(options, () => { nexted = true; return (async function* () {})() })
    assert.equal(nexted, true)
    assert.equal(calls.length, 0)
  } finally {
    doc.cleanup()
  }
})

test('llm/stream：dispatchScrub=false 时退回只读扫描（不改写）', () => {
  const doc = blocklistDoc()
  try {
    const calls = []
    const f = mount(doc.path, llmStub(calls), { dispatchScrub: false })
    const options = { provider: 'p', model: 'm', messages: [userMessage(`含 ${RULE}`)] }
    let nexted = false
    f.first('llm/stream')(options, () => { nexted = true; return (async function* () {})() })
    assert.equal(nexted, true)
    assert.equal(calls.length, 0)
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('出网前仍有 1 处')))
  } finally {
    doc.cleanup()
  }
})

test('agent/request-error：400 → 重试；其它失败放行；超过上限不再重试', async () => {
  const doc = blocklistDoc()
  try {
    const f = mount(doc.path, llmStub([]), { maxRecoveries: 1 })
    const handler = f.first('agent/request-error')
    assert.equal(await handler({ failure: { status: 500, code: 'SERVER' } }, async () => undefined), undefined, '非 400 放行')
    assert.deepEqual(
      await handler({ failure: { status: 400, code: 'INVALID_REQUEST', message: 'Content Exists Risk' } }, async () => undefined),
      { kind: 'retry' },
    )
    assert.equal(
      await handler({ failure: { status: 400, code: 'INVALID_REQUEST' } }, async () => undefined),
      undefined,
      '窗口内达到上限后放弃，避免 400 循环',
    )
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(s.recoveries, 1)
    assert.equal(s.last400, 'INVALID_REQUEST')
    assert.equal(s.aggressive, true, '400 之后进入加硬清洗')
  } finally {
    doc.cleanup()
  }
})

test('400 之后：没有写进屏蔽表的 emoji 也会被加硬清洗剥离', async () => {
  const doc = blocklistDoc(['规则外的词']) // 屏蔽表里没有 emoji
  try {
    const calls = []
    const f = mount(doc.path, llmStub(calls))
    await f.first('agent/request-error')({ failure: { status: 400, code: 'INVALID_REQUEST' } }, async () => undefined)
    const options = { provider: 'deepseek-official', model: 'deepseek-flash', messages: [userMessage(`含 ${EMOJI} 的文本`)] }
    f.first('llm/stream')(options, () => (async function* () {})())
    assert.equal(calls.length, 1)
    assert.equal(calls[0][2].messages[0].content[0].text, '含 [BLOCKED] 的文本')
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('加硬清洗')))
  } finally {
    doc.cleanup()
  }
})
