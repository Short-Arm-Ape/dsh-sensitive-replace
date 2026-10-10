// v0.7.0 用例：① 屏蔽表里「写错了却不报错」的形态，在加载期变成显式警告；
// ② 规则级命中计数——状态工具只给编号 / 位置 / 次数 / 距今秒数，绝不外发规则文本。
// 所有 provider、model、规则一律是编造的占位符，与任何真实屏蔽表无关。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, parseBlocklist, replaceText, ruleIndex } from '../lib/index.js'

const R_GLOBAL = 'zq-global-demo-7f21'
const R_PROV = 'zq-provider-demo-7f21'
const R_MODEL = 'zq-model-demo-7f21'

// ============ ① 形态警告（纯解析，不需要挂载）============

test('形态警告：models: 写成与 provider 键同级 → 被当成 provider id 并告警', () => {
  const bl = parseBlocklist(`
providers:
  'example-provider-cn':
    _: ['A']
  models:
    'model-a': ['B']
`, 1)
  const all = (bl.warnings ?? []).join('\n')
  assert.ok(all.includes('providers.models 被当成一个 provider id'), '要指出它被当成了 provider id')
  assert.ok(all.includes('正确写法是 providers.<provider id>.models'), '要给出正确写法')
})

test('形态警告：顶层 models / global 非数组 / provider 下直接写模型名', () => {
  const bl = parseBlocklist(`
global: 'not-a-list'
providers:
  'example-provider-cn':
    'model-a': ['B']
models:
  'model-a': ['C']
`, 1)
  const all = (bl.warnings ?? []).join('\n')
  assert.ok(all.includes('global 必须是数组'))
  assert.ok(all.includes('顶层出现 models'))
  assert.ok(all.includes('未识别的键 "model-a"'), '模型名直接写在 provider 下要报出来')
  assert.ok(all.includes('没解析出任何规则'), '静默失效的结局要点明')
})

test('形态警告：非字符串条目只报一次（数字/布尔请加引号）', () => {
  const bl = parseBlocklist(`
global:
  - 12345
  - true
  - 'ok-rule'
`, 1)
  const skipped = (bl.warnings ?? []).filter((w) => w.includes('非字符串条目'))
  assert.equal(skipped.length, 1, '同一位置只报一次，避免刷屏')
  assert.deepEqual(bl.global, ['ok-rule'])
})

test('形态警告：合法文档零警告；规则编号按「global → provider._ → models」出现顺序', () => {
  const bl = parseBlocklist(`
global:
  - 'g'
providers:
  'p*':
    _:
      - 'b'
    models:
      'model-a-*':
        - 'm'
`, 1)
  assert.equal(bl.warnings, undefined)
  const { order, scopeOf } = ruleIndex(bl)
  assert.deepEqual(order, ['g', 'b', 'm'])
  assert.equal(scopeOf.get('g'), 'global')
  assert.equal(scopeOf.get('b'), 'providers.p*')
  assert.equal(scopeOf.get('m'), 'providers.p*/models.model-a-*')
})

test('replaceText 的 sink 回调：按规则回报次数，且不影响原有返回值', () => {
  const seen = []
  const r = replaceText('AA BB AA', ['AA', 'BB'], '[BLOCKED]', (rule, n) => seen.push([rule, n]))
  assert.deepEqual(seen, [['AA', 2], ['BB', 1]])
  assert.equal(r.count, 3)
  assert.equal(r.text, '[BLOCKED] [BLOCKED] [BLOCKED]')
  assert.equal(replaceText('AA', ['AA'], '[BLOCKED]').count, 1, '不传 sink 时行为不变')
})

// ============ ② 规则级命中计数（假 ctx 驱动真实监听器）============

function blocklistDoc(text) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-v070-'))
  const path = join(dir, 'sensitive-blocklist.yaml')
  writeFileSync(path, text)
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

function mount(path, overrides = {}) {
  const calls = []
  const llm = {
    stream: (o) => { calls.push(['stream', o]); return (async function* () {})() },
    adapterStream: (o, prepared) => { calls.push(['adapterStream', prepared, o]); return (async function* () {})() },
  }
  const f = fakeCtx(llm)
  apply(f.ctx, {
    enabled: true,
    autoReplace: true,
    dispatchScrub: true,
    detectUnfiltered: true,
    recoverOn400: true,
    blocklistPath: path,
    replaceWith: '[BLOCKED]',
    ...overrides,
  })
  return {
    ...f,
    calls,
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

const userMessage = (text, id = 'm1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

test('规则级命中计数：三道关口的命中落到对应规则编号，状态里不含规则文本', async () => {
  const doc = blocklistDoc(`global:
  - '${R_GLOBAL}'
providers:
  'example-provider-cn':
    _:
      - '${R_PROV}'
    models:
      'model-a-20260101':
        - '${R_MODEL}'
`)
  try {
    const f = mount(doc.path)
    // 1) 进上下文（消息）：路由未定 → 只套 global 规则，命中 2 处
    await f.first('agent/pre-step')(
      { agent: { id: 's1' } },
      async () => ({ kind: 'enter', messages: [userMessage(`${R_GLOBAL} and ${R_GLOBAL}`)] }),
    )
    // 2) 工具结果：先让路由落定，再让 provider 基础规则 + 模型规则各命中 1 处
    await f.first('agent/request')({ agent: { id: 's1' } }, async () => ({
      provider: 'example-provider-cn',
      model: 'model-a-20260101',
    }))
    await f.first('tools/post-execute')(
      { agent: { id: 's1' }, name: 'read' },
      { content: [] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: `${R_PROV} / ${R_MODEL}` }] }),
    )
    // 3) 出网前：整份请求里的历史副本再命中 1 处 global
    f.first('llm/stream')(
      { provider: 'example-provider-cn', model: 'model-a-20260101', messages: [userMessage(`again ${R_GLOBAL}`)] },
      () => (async function* () {})(),
    )

    const s = await f.tool('sensitive_replace_status').execute({})
    assert.deepEqual(
      s.ruleHits.map((h) => [h.n, h.scope, h.count]),
      [
        [1, 'global', 3],
        [2, 'providers.example-provider-cn', 1],
        [3, 'providers.example-provider-cn/models.model-a-20260101', 1],
      ],
    )
    for (const h of s.ruleHits) {
      assert.equal(typeof h.lastAgoS, 'number')
      assert.ok(h.lastAgoS >= 0)
    }
    const json = JSON.stringify(s)
    for (const rule of [R_GLOBAL, R_PROV, R_MODEL]) {
      assert.equal(json.includes(rule), false, '状态输出里绝不能出现规则文本')
    }
    assert.deepEqual(s.warningList, [], '合法屏蔽表没有警告')
    const rendered = f.tool('sensitive_replace_status').output.render({}, s)[0].text
    assert.ok(rendered.includes('#1x3'), '渲染里要能看到编号与次数')
    assert.equal(rendered.includes(R_GLOBAL), false)
  } finally {
    doc.cleanup()
  }
})

test('没命中的规则不出现在计数里；状态仍报规则总数', async () => {
  const doc = blocklistDoc(`global:
  - '${R_GLOBAL}'
  - 'zq-never-hit-7f21'
`)
  try {
    const f = mount(doc.path)
    await f.first('agent/pre-step')(
      { agent: { id: 's2' } },
      async () => ({ kind: 'enter', messages: [userMessage(`只有 ${R_GLOBAL}`)] }),
    )
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(s.rulesGlobal, 2)
    assert.deepEqual(s.ruleHits.map((h) => [h.n, h.count]), [[1, 1]])
  } finally {
    doc.cleanup()
  }
})

test('屏蔽表被改成写错的形态：热重载时把警告打进运行日志', async () => {
  const doc = blocklistDoc("global:\n  - 'zq-ok-7f21'\n")
  try {
    const f = mount(doc.path)
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'info' && m.includes('ready')), '挂载时要有 ready 行')
    assert.equal(f.logs.some(([, m]) => m.includes('屏蔽表警告')), false, '合法文档不告警')
    assert.deepEqual((await f.tool('sensitive_replace_status').execute({})).warningList, [])

    writeFileSync(doc.path, "providers:\n  'example-provider-cn':\n    'model-a': ['B']\n")
    const future = new Date(Date.now() + 5000)
    utimesSync(doc.path, future, future) // 强制 mtime 变化：drvfs 上时间戳精度可能只有秒
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.ok(s.warningList.length >= 1, '形态写错要在状态里可见')
    assert.ok(
      f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('屏蔽表警告') && m.includes('未识别的键')),
      '热重载后要打到运行日志，而不是只躺在工具返回值里',
    )
  } finally {
    doc.cleanup()
  }
})
