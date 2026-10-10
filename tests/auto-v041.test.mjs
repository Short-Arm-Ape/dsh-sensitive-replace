// v0.4.1 自动面用例：进上下文前清洗（agent/pre-step + tools/post-execute）、
// 路由追踪、以及出网前只读扫描。都用假 ctx 捕获真实注册的监听器来驱动，
// 不是只测纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const RULE = 'blocklist-check-9f3a8c21e7'

/** 建一个临时屏蔽表文档，返回路径与清理函数 */
function blocklistDoc(text) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-'))
  const path = join(dir, 'sensitive-blocklist.yaml')
  writeFileSync(path, text)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 假 cordis ctx：记录监听器/日志/注册的工具 */
function fakeCtx() {
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
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, handlers, logs, tools }
}

/** 挂载插件并返回 { handlers, logs, first(name) } */
function mount(path, overrides = {}) {
  const f = fakeCtx()
  apply(f.ctx, {
    enabled: true,
    autoReplace: true,
    detectUnfiltered: true,
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
  }
}

const userMessage = (text, id = 'm1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const enter = (messages) => async () => ({ kind: 'enter', messages })
const accept = () => async () => ({ kind: 'accept' })

test('pre-step：命中内容在进入步骤前被替换，消息 id 保留、原对象不被改写', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const original = userMessage(`hello ${RULE} world`)
    const decision = await f.first('agent/pre-step')({ agent: { id: 's1' } }, enter([original]))
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1)
    assert.equal(decision.messages[0].content[0].text, 'hello [BLOCKED] world')
    assert.equal(decision.messages[0].id, 'm1', '消息身份必须保留')
    assert.ok(Object.isFrozen(decision.messages[0]), '替换后的消息必须不可变')
    assert.equal(original.content[0].text, `hello ${RULE} world`, '原消息不得被原地改写')
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('进入上下文前替换 1 处')))
  } finally {
    doc.cleanup()
  }
})

test('pre-step：无命中时原样返回同一个决策对象（不制造无谓改动）', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const decision = { kind: 'enter', messages: [userMessage('nothing here')] }
    const out = await f.first('agent/pre-step')({ agent: { id: 's1' } }, async () => decision)
    assert.equal(out, decision)
  } finally {
    doc.cleanup()
  }
})

test('pre-step：屏蔽表为空时不介入', async () => {
  const doc = blocklistDoc('global: []\n')
  try {
    const f = mount(doc.path)
    const decision = { kind: 'enter', messages: [userMessage(`hello ${RULE}`)] }
    const out = await f.first('agent/pre-step')({ agent: { id: 's1' } }, async () => decision)
    assert.equal(out, decision)
  } finally {
    doc.cleanup()
  }
})

test('pre-step：reject 决策原样透传', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const decision = { kind: 'reject' }
    const out = await f.first('agent/pre-step')({ agent: { id: 's1' } }, async () => decision)
    assert.equal(out, decision)
  } finally {
    doc.cleanup()
  }
})

test('post-execute：工具结果 content 被替换为非原地的新块', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const result = { content: [{ type: 'text', text: `fetched ${RULE} ok` }], isError: false }
    const decision = await f.first('tools/post-execute')(
      { agent: { id: 's1' }, name: 'web_fetch' },
      result,
      accept(),
    )
    assert.equal(decision.kind, 'accept')
    assert.deepEqual(decision.content, [{ type: 'text', text: 'fetched [BLOCKED] ok' }])
    assert.equal(result.content[0].text, `fetched ${RULE} ok`, '原结果不得被原地改写')
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('工具结果进入上下文前替换 1 处')))
  } finally {
    doc.cleanup()
  }
})

test('post-execute：tool-result 嵌套块也被替换', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const result = {
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: `nested ${RULE}` }] }],
      isError: false,
    }
    const decision = await f.first('tools/post-execute')({ agent: { id: 's1' }, name: 'bash' }, result, accept())
    assert.equal(decision.content[0].content[0].text, 'nested [BLOCKED]')
  } finally {
    doc.cleanup()
  }
})

test('post-execute：无命中 / value 形态 / block 决策都不动 content', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const handler = f.first('tools/post-execute')

    const clean = { kind: 'accept' }
    assert.equal(await handler({ agent: { id: 's1' }, name: 'bash' }, { content: [{ type: 'text', text: 'clean' }] }, async () => clean), clean)

    const withValue = { kind: 'accept', value: { any: 1 } }
    assert.equal(await handler({ agent: { id: 's1' }, name: 'bash' }, { content: [{ type: 'text', text: RULE }] }, async () => withValue), withValue)

    const blocked = { kind: 'block', feedback: [{ type: 'text', text: RULE }] }
    assert.equal(await handler({ agent: { id: 's1' }, name: 'bash' }, { content: [] }, async () => blocked), blocked)
  } finally {
    doc.cleanup()
  }
})

test('路由追踪：agent/request 之后的进上下文阶段套用 provider 专属规则', async () => {
  const doc = blocklistDoc(`global: []\nproviders:\n  deepseek-official:\n    - '专属词'\n`)
  try {
    const f = mount(doc.path)
    const preStep = f.first('agent/pre-step')
    const request = f.first('agent/request')

    // 路由未定时只套 global ⇒ 专属词不动
    const before = { kind: 'enter', messages: [userMessage('提到专属词')] }
    assert.equal(await preStep({ agent: { id: 's1' } }, async () => before), before)

    // 记录路由（返回值必须原样透传）
    const call = { provider: 'deepseek-official', model: 'deepseek-flash' }
    assert.equal(await request({ agent: { id: 's1' } }, async () => call), call)

    const decision = await preStep({ agent: { id: 's1' } }, async () => ({ kind: 'enter', messages: [userMessage('提到专属词')] }))
    assert.equal(decision.messages[0].content[0].text, '提到[BLOCKED]')
  } finally {
    doc.cleanup()
  }
})

test('路由追踪：agent/disposed 后回到「只 global」', async () => {
  const doc = blocklistDoc(`global: []\nproviders:\n  deepseek-official:\n    - '专属词'\n`)
  try {
    const f = mount(doc.path)
    const preStep = f.first('agent/pre-step')
    await f.first('agent/request')({ agent: { id: 's1' } }, async () => ({ provider: 'deepseek-official' }))
    f.first('agent/disposed')({ agent: { id: 's1' } })
    const decision = { kind: 'enter', messages: [userMessage('提到专属词')] }
    assert.equal(await preStep({ agent: { id: 's1' } }, async () => decision), decision)
  } finally {
    doc.cleanup()
  }
})

test('出网前扫描：只告警不改写，且覆盖 tool-call 参数', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path)
    const options = {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `still ${RULE}` }] },
        { id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: `{"command":"echo ${RULE}"}` }] },
      ],
    }
    let nextCalled = false
    f.first('llm/stream')(options, () => { nextCalled = true; return (async function* () {})() })
    assert.ok(nextCalled, '必须继续请求链')
    assert.equal(options.messages[0].content[0].text, `still ${RULE}`, '冻结请求不得被改写')
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('出网前仍有 2 处')))
  } finally {
    doc.cleanup()
  }
})

test('detectUnfiltered=false 时不注册出网前扫描', () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path, { detectUnfiltered: false })
    assert.equal(f.handlers.has('llm/stream'), false)
  } finally {
    doc.cleanup()
  }
})

test('autoReplace=false 时不注册进上下文清洗，但工具面仍在', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const f = mount(doc.path, { autoReplace: false })
    assert.equal(f.handlers.has('agent/pre-step'), false)
    assert.equal(f.handlers.has('tools/post-execute'), false)
    assert.ok(f.handlers.has('llm/stream'), '出网前扫描独立于 autoReplace')
    assert.deepEqual(f.tools.map((t) => t.name), ['replace_sensitive', 'sensitive_replace_status'])
  } finally {
    doc.cleanup()
  }
})

test('屏蔽表坏掉时不抛：清洗监听器放行、工具面报 note', async () => {
  const doc = blocklistDoc('global: [ "unterminated\n')
  try {
    const f = mount(doc.path)
    const decision = { kind: 'enter', messages: [userMessage(`hello ${RULE}`)] }
    assert.equal(await f.first('agent/pre-step')({ agent: { id: 's1' } }, async () => decision), decision)
    const tool = f.tools.find((t) => t.name === 'replace_sensitive')
    const out = await tool.execute({ text: 'x' })
    assert.equal(out.ok, true)
    assert.match(out.note, /YAML 解析失败/)
  } finally {
    doc.cleanup()
  }
})

test('根因回归：对平台真实冻结消息（dsh-llm 工厂产出）同样能清洗', async () => {
  const doc = blocklistDoc(`global:\n  - '${RULE}'\n`)
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const frozen = createUserMessage({ content: [{ type: 'text', text: `frozen ${RULE}` }] })
    // 前提：平台消息确实是深冻结的（v0.4.0 的原地改写正是在这里抛错）
    assert.ok(Object.isFrozen(frozen))
    assert.ok(Object.isFrozen(frozen.content))
    assert.ok(Object.isFrozen(frozen.content[0]))

    const f = mount(doc.path)
    const decision = await f.first('agent/pre-step')({ agent: { id: 's1' } }, async () => ({ kind: 'enter', messages: [frozen] }))
    assert.equal(decision.messages[0].content[0].text, 'frozen [BLOCKED]')
    assert.equal(decision.messages[0].id, frozen.id, '冻结消息也要保留身份')
    assert.equal(frozen.content[0].text, `frozen ${RULE}`, '原冻结消息（会话日志的来源）不改动')
  } finally {
    doc.cleanup()
  }
})
