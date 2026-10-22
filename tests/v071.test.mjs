// v0.7.1 用例：屏蔽表文件不存在时自动创建一张空表模板（而不是静默空转/报错）。
// 关键约束：绝不覆盖已存在的文件；创建失败只告警不抛；建出来的模板本身要能解析、0 规则 0 警告。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, ensureBlocklist, parseBlocklist, BLOCKLIST_TEMPLATE } from '../lib/index.js'

const RULE = 'zq-autocreate-7f21'

/** 一个空目录（屏蔽表还不存在） */
function emptyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-v071-'))
  return { dir, path: join(dir, 'sensitive-blocklist.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

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
    get: () => undefined,
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, handlers, logs, tools }
}

function mount(path, overrides = {}) {
  const f = fakeCtx()
  apply(f.ctx, {
    enabled: true,
    autoReplace: true,
    blocklistPath: path,
    replaceWith: '[BLOCKED]',
    ...overrides,
  })
  return {
    ...f,
    tool(name) {
      const t = f.tools.find((x) => x.name === name)
      assert.ok(t, `没有注册工具: ${name}`)
      return t
    },
  }
}

test('ensureBlocklist：文件不存在 → 创建空表模板，且模板解析为 0 规则 0 警告', () => {
  const d = emptyDir()
  try {
    const r = ensureBlocklist(d.path)
    assert.deepEqual([r.created, r.exists, r.reason], [true, true, 'missing'])
    assert.ok(existsSync(d.path), '文件应当已创建')
    const text = readFileSync(d.path, 'utf8')
    assert.equal(text, BLOCKLIST_TEMPLATE, '写进去的就是模板本身')
    const bl = parseBlocklist(text, 1)
    assert.equal(bl.parseError, undefined)
    assert.equal(bl.warnings, undefined, '模板不该触发任何形态警告')
    assert.deepEqual(bl.global, [])
    assert.deepEqual(Object.keys(bl.byProvider), [])
  } finally {
    d.cleanup()
  }
})

test('模板只用码位、不含真实字形（守住"源码不带屏蔽字符字形"的约定）', () => {
  assert.equal(/\p{Extended_Pictographic}/u.test(BLOCKLIST_TEMPLATE), false, '模板里出现了 emoji 字形')
  assert.equal(BLOCKLIST_TEMPLATE.includes('\\u{1F600}'), true, '码位示例要以转义文本形式出现')
})

test('ensureBlocklist：已存在则不覆盖（内容一字不动），二次调用报 exists', () => {
  const d = emptyDir()
  try {
    writeFileSync(d.path, "global:\n  - 'mine'\n")
    const before = readFileSync(d.path, 'utf8')
    const r = ensureBlocklist(d.path)
    assert.deepEqual([r.created, r.reason], [false, 'exists'])
    assert.equal(readFileSync(d.path, 'utf8'), before, '已有文件不得被改写')
  } finally {
    d.cleanup()
  }
})

test('ensureBlocklist：父目录不存在时一并创建', () => {
  const d = emptyDir()
  try {
    const nested = join(d.dir, 'a', 'b', 'sensitive-blocklist.yaml')
    const r = ensureBlocklist(nested)
    assert.equal(r.created, true)
    assert.ok(existsSync(nested))
  } finally {
    d.cleanup()
  }
})

test('ensureBlocklist：创建失败只回报原因、不抛异常', () => {
  const d = emptyDir()
  try {
    const blocker = join(d.dir, 'iam-a-file')
    writeFileSync(blocker, 'x')
    const r = ensureBlocklist(join(blocker, 'nested', 'sensitive-blocklist.yaml'))
    assert.equal(r.created, false)
    assert.equal(r.exists, false)
    assert.ok(r.reason.length > 0, '要说明失败原因')
  } finally {
    d.cleanup()
  }
})

test('挂载即建表：missing → 建好、状态可见、日志有交代、消息照常通过', async () => {
  const d = emptyDir()
  try {
    const f = mount(d.path)
    assert.ok(existsSync(d.path), '挂载时就该把表建好')
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(s.blocklistExists, true)
    assert.equal(s.rulesGlobal, 0)
    assert.equal(s.parseError, undefined)
    assert.ok(
      f.logs.some(([lvl, m]) => lvl === 'info' && m.includes('已创建空表模板')),
      '要让用户知道表建在哪：' + JSON.stringify(f.logs),
    )
    // 空表下，消息原样通过（不因为没表就报错）
    const decision = await f.handlers.get('agent/pre-step')[0](
      { agent: { id: 's1' } },
      async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }] }),
    )
    assert.equal(decision.messages[0].content[0].text, 'hello')
  } finally {
    d.cleanup()
  }
})

test('自动建出来的表照常热重载：填一条规则、改 mtime 后立刻生效', async () => {
  const d = emptyDir()
  try {
    const f = mount(d.path)
    writeFileSync(d.path, `global:\n  - '${RULE}'\n`)
    const future = new Date(Date.now() + 5000)
    utimesSync(d.path, future, future) // drvfs 上 mtime 精度可能只有秒
    const decision = await f.handlers.get('agent/pre-step')[0](
      { agent: { id: 's2' } },
      async () => ({
        kind: 'enter',
        messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `a ${RULE} b` }] }],
      }),
    )
    assert.equal(decision.messages[0].content[0].text, 'a [BLOCKED] b')
  } finally {
    d.cleanup()
  }
})

test('createBlocklistIfMissing=false：不建文件，也不抛，日志说明空转', () => {
  const d = emptyDir()
  try {
    const f = mount(d.path, { createBlocklistIfMissing: false })
    assert.equal(existsSync(d.path), false, '关掉开关就不该写盘')
    assert.ok(f.logs.some(([, m]) => m.includes('屏蔽表不存在')), '要交代自动面空转')
  } finally {
    d.cleanup()
  }
})

test('创建失败时挂载不影响插件：只告警，工具面照常可用', async () => {
  const d = emptyDir()
  try {
    const blocker = join(d.dir, 'iam-a-file')
    writeFileSync(blocker, 'x')
    const f = mount(join(blocker, 'nested', 'sensitive-blocklist.yaml'))
    assert.ok(f.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('自动创建失败')), '要告警：' + JSON.stringify(f.logs))
    const s = await f.tool('sensitive_replace_status').execute({})
    assert.equal(s.ok, true, '工具面不该因为建不了表而失败')
    assert.equal(s.blocklistExists, false)
  } finally {
    d.cleanup()
  }
})
