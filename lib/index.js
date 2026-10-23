import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
export const name = 'agent-sensitive-replace';
export const inject = ['tools'];
/** 本构建的版本：随 package.json 同步，并通过 sensitive_replace_status 暴露，便于确认运行时加载的是哪一份 */
export const PLUGIN_VERSION = '0.7.2';
const DEFAULT_REPLACE = '[BLOCKED]';
/**
 * 加硬清洗额外使用的码位类：emoji / 旗帜 / 杂项符号 / 变体选择符 / ZWJ / 组合键帽。
 * 官方审核最常硬命中的就是这一类；用户还没来得及把具体字填进屏蔽表时靠它兜底。
 */
const AGGRESSIVE_RULE = 're:[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}' +
    '\u{FE0F}\u{200D}\u{20E3}]+';
/** 400 自动恢复的滑动窗口（ms） */
const RECOVERY_WINDOW_MS = 600_000;
export const Config = z.object({
    enabled: z.boolean().default(true),
    autoReplace: z.boolean().default(true),
    dispatchScrub: z.boolean().default(true),
    /**
     * v0.6.0：是否也清洗「从会话日志重建」的请求（rc2 起带 sessionId 的请求）。
     * 平台不变量（dsh-agent-loop）声明这类请求由日志纯函数派生、监听器只读不改写；
     * 关掉此开关即严格守约（只保留进上下文清洗 + 只读告警），默认开＝保留 v0.5.0 的应急网。
     */
    scrubDurableRequests: z.boolean().default(true),
    detectUnfiltered: z.boolean().default(true),
    recoverOn400: z.boolean().default(true),
    aggressiveMs: z.number().default(600_000),
    aggressive: z.boolean().default(false),
    maxRecoveries: z.number().default(2),
    blocklistPath: z.string().required(false),
    /**
     * v0.7.1：屏蔽表文件不存在时自动创建一张空表模板（默认开）。
     * 过去文件缺失只会静默空转，用户不知道该往哪填；现在首次启动就把文件放好。
     * 已存在则绝不覆盖；创建失败只告警，插件照常运行（规则为空）。
     */
    createBlocklistIfMissing: z.boolean().default(true),
    replaceWith: z.string().default(DEFAULT_REPLACE),
});
export function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
/** 把 YAML 值里的 \u{XXXX} 码位转义替换成真实字符（也兼容 \uXXXX 形式） */
export function decodeEscapes(s) {
    return s
        .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\u([0-9a-fA-F]{4})(?:\\u([0-9a-fA-F]{4}))?/g, (_, a, b) => String.fromCharCode(parseInt(a, 16)) + (b ? String.fromCharCode(parseInt(b, 16)) : ''));
}
/** 值的人话类型（警告文案里用） */
function valueKind(v) {
    if (v === null)
        return 'null';
    if (Array.isArray(v))
        return '数组';
    const t = typeof v;
    if (t === 'object')
        return '映射';
    if (t === 'string')
        return '字符串';
    if (t === 'number')
        return '数字';
    if (t === 'boolean')
        return '布尔';
    return t;
}
/**
 * 解析屏蔽表文档文本（YAML：{ global, providers }）→ Blocklist；provider 值可为数组或对象。
 *
 * v0.7.0 起把「写错了却不会报错」的形态记进 `warnings`（加载期打到运行日志，
 * replace_sensitive / sensitive_replace_status 也看得到）：静默失效意味着用户以为
 * 规则在防抖、实际一条都没生效。警告只报**位置与形态**，不复制规则内容。
 */
export function parseBlocklist(text, mtimeMs) {
    const bl = { global: [], byProvider: {}, mtimeMs, exists: true };
    let doc;
    try {
        doc = yaml.load(text);
    }
    catch (err) {
        bl.parseError = 'YAML 解析失败: ' + String(err);
        return bl;
    }
    const warn = (m) => { (bl.warnings ??= []).push(m); };
    if (doc !== null && doc !== undefined && (typeof doc !== 'object' || Array.isArray(doc)))
        warn('文档顶层必须是映射（global / providers），当前是 ' + valueKind(doc) + '——整个文档被忽略');
    const root = (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
    for (const k of Object.keys(root)) {
        if (k === 'global' || k === 'providers')
            continue;
        warn(k === 'models'
            ? '顶层出现 models：它被当成一个顶层键忽略了——模型规则要写在 providers.<provider id>.models 下'
            : '顶层出现未识别的键 "' + k + '"（只认 global 与 providers），已忽略');
    }
    if (root.global !== undefined && !Array.isArray(root.global))
        warn('global 必须是数组，当前是 ' + valueKind(root.global) + '——已忽略');
    /** 同一个 scope 里的非字符串条目只报一次，避免刷屏 */
    const reported = new Set();
    const pushItems = (items, target, scope) => {
        if (!Array.isArray(items))
            return;
        for (const it of items) {
            if (typeof it !== 'string') {
                if (!reported.has(scope)) {
                    reported.add(scope);
                    warn(scope + ' 里有非字符串条目（' + valueKind(it) + '），已跳过——数字/布尔请加引号');
                }
                continue;
            }
            const d = decodeEscapes(it).trim();
            if (d.length > 0)
                target.push(d);
        }
    };
    pushItems(root.global, bl.global, 'global');
    if (root.providers !== undefined && (root.providers === null || typeof root.providers !== 'object' || Array.isArray(root.providers)))
        warn('providers 必须是映射（providers.<id>: 规则），当前是 ' + valueKind(root.providers) + '——已忽略');
    const provs = (root.providers !== null && typeof root.providers === 'object' && !Array.isArray(root.providers))
        ? root.providers
        : {};
    for (const [k, v] of Object.entries(provs)) {
        const entry = { base: [], models: {} };
        const scope = 'providers.' + k;
        if (k.toLowerCase() === 'models')
            warn('providers.models 被当成一个 provider id 了——通常是把 models: 写在了与 provider 键同级；正确写法是 providers.<provider id>.models.<model>');
        if (Array.isArray(v)) {
            // 旧形态：providers.<id>: [ ... ] → 基础规则
            pushItems(v, entry.base, scope);
        }
        else if (v !== null && typeof v === 'object') {
            // 新形态：providers.<id>: { _: [...], models: { <model>: [...] } }
            const o = v;
            for (const key of Object.keys(o)) {
                if (key === '_' || key === 'models')
                    continue;
                warn(scope + ' 下出现未识别的键 "' + key + '"（只认 _ 与 models）——模型规则必须写在 models: 下，直接写模型名不会生效');
            }
            pushItems(o._, entry.base, scope + '._');
            if (o.models !== undefined && (o.models === null || typeof o.models !== 'object' || Array.isArray(o.models)))
                warn(scope + '.models 必须是映射（模型名 → 规则数组），当前是 ' + valueKind(o.models) + '——已忽略');
            const models = (o.models !== null && typeof o.models === 'object' && !Array.isArray(o.models)) ? o.models : {};
            for (const [mk, mv] of Object.entries(models)) {
                const arr = [];
                if (Array.isArray(mv))
                    pushItems(mv, arr, scope + '.models.' + mk);
                else if (typeof mv === 'string') {
                    const d = decodeEscapes(mv).trim();
                    if (d.length > 0)
                        arr.push(d);
                }
                else
                    warn(scope + '.models.' + mk + ' 必须是数组或字符串，当前是 ' + valueKind(mv) + '——已忽略');
                entry.models[mk.toLowerCase()] = arr;
            }
        }
        else
            warn(scope + ' 必须是数组（基础规则）或映射（{ _ , models }），当前是 ' + valueKind(v) + '——已忽略');
        bl.byProvider[k.toLowerCase()] = entry;
    }
    // 兜底：解析完却一条规则都没有——上面各种写错法最常见的结局
    for (const [id, e] of Object.entries(bl.byProvider)) {
        const n = e.base.length + Object.values(e.models).reduce((a, x) => a + x.length, 0);
        if (n === 0)
            warn('providers.' + id + ' 没解析出任何规则——检查规则是否写在 _（基础）或 models: 下');
    }
    // 非致命校验：re: 正则无效 → 记警告（条目保留但永不命中；只报位置，不复制模式文本）
    const warnBadRegex = (rule, scope, pos) => {
        const pat = rule.slice(3);
        try {
            new RegExp(pat, 'u');
        }
        catch (err) {
            warn('正则无效（已跳过）: ' + scope + ' 第 ' + pos + ' 条 — ' + String(err));
        }
    };
    bl.global.forEach((r, i) => { if (r.startsWith('re:'))
        warnBadRegex(r, 'global', i + 1); });
    for (const [id, e] of Object.entries(bl.byProvider)) {
        e.base.forEach((r, i) => { if (r.startsWith('re:'))
            warnBadRegex(r, 'providers.' + id, i + 1); });
        for (const [mk, arr] of Object.entries(e.models))
            arr.forEach((r, i) => { if (r.startsWith('re:'))
                warnBadRegex(r, 'providers.' + id + '.models.' + mk, i + 1); });
    }
    return bl;
}
const EMPTY_BLOCKLIST = { global: [], byProvider: {}, mtimeMs: 0, exists: false };
/**
 * 自动创建用的空表模板（v0.7.1）：只有结构说明与空列表，**不含任何屏蔽词**。
 * `global: []` / `providers: {}` 解析结果就是 0 条规则、0 条警告，用户填进去即生效。
 */
export const BLOCKLIST_TEMPLATE = `# 敏感字符屏蔽表（dsh-sensitive-replace）
# 本文件在插件首次启动、发现它不存在时自动创建，内容为空 —— 填进去才会生效。
# 保存即生效（按文件 mtime 热重载），不用重启 DSH。
#
# 三种写法：
#   global:                        对所有 Provider ID 生效
#     - '\\u{1F600}'                码位写法（示例占位，换成你要屏蔽的字符）
#     - 're:机密[0-9]{2,}'          正则（re: 前缀）
#   providers:                     按 DSH 的 provider 路由 id 分（如 deepseek-official）
#     deepseek-official:
#       _: [ ... ]                 该 provider 所有模型的基础规则
#       models:
#         'deepseek-flash': [ ... ]  只对某个模型生效（键尾 * 为前缀模式）
#
# 两个容易写错的地方（写错会有警告，不会静默失效）：
#   1. 模型规则必须写在 models: 下；直接写在 provider 下不生效。
#   2. models: 别写成与 provider 键同级，否则它会被当成另一个 provider。
global: []
providers: {}
`;
/**
 * 屏蔽表不存在就建一张空表（v0.7.1）。
 *
 * 只用 `wx` 独占创建，因此**绝不会覆盖**已存在的文件（并发下也一样）；
 * 父目录不存在会一并创建；任何失败都只返回原因、不抛异常 —— 插件照常跑，
 * 只是规则为空，调用方把原因写进日志即可。
 */
export function ensureBlocklist(path, template = BLOCKLIST_TEMPLATE) {
    try {
        if (statSync(path).isFile())
            return { created: false, exists: true, reason: 'exists' };
    }
    catch { /* 不存在（ENOENT）或不可读：继续尝试创建，读不了也会在 wx 处失败并如实回报 */ }
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, template, { flag: 'wx' });
        return { created: true, exists: true, reason: 'missing' };
    }
    catch (err) {
        if (err.code === 'EEXIST')
            return { created: false, exists: true, reason: 'exists' };
        return { created: false, exists: false, reason: String(err) };
    }
}
/** 读屏蔽表文档（带 mtime 缓存，变化才重读） */
export function loadBlocklist(path, cached) {
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(path).mtimeMs;
    }
    catch {
        return cached ?? { ...EMPTY_BLOCKLIST };
    }
    if (cached && cached.exists && cached.mtimeMs === mtimeMs)
        return cached;
    try {
        const text = readFileSync(path, 'utf8');
        return parseBlocklist(text, mtimeMs);
    }
    catch {
        return cached ?? { ...EMPTY_BLOCKLIST };
    }
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** 规则条目 → 正则（无效正则返回 undefined；调用方跳过而不中断其它规则） */
function ruleRegExp(rule) {
    const pat = rule.startsWith('re:') ? rule.slice(3) : escapeRegExp(rule);
    try {
        return new RegExp(pat, 'gu');
    }
    catch {
        return undefined;
    }
}
/**
 * 替换一段文本，返回新文本与命中次数（重复命中逐次计数）。
 * replaceWith 含 {n} 时按规则序号（1 起：global 在前、当前 provider 在后）编号，
 * 便于按屏蔽表还原原文；条目以 re: 开头按正则编译（无效正则跳过，不中断其它规则）。
 * hits 仅在启用编号且实际命中时返回（undefined 键不发——平台 lossless-JSON 契约）。
 *
 * v0.7.0：可选 `sink(rule, count)` 回调，把「哪条规则命中了几次」交回调用方累计
 * （自动面用它做规则级计数；文本本身不外泄，状态工具只给编号与次数）。
 */
export function replaceText(text, rules, replaceWith, sink) {
    if (!rules || rules.length === 0)
        return { text, count: 0 };
    const usesNumber = replaceWith.includes('{n}');
    const hits = new Map();
    let current = text;
    let total = 0;
    rules.forEach((rule, i) => {
        const re = ruleRegExp(rule);
        if (re === undefined)
            return; // 无效正则（parse 时已记警告），跳过
        const ph = usesNumber ? replaceWith.replaceAll('{n}', String(i + 1)) : replaceWith;
        let cnt = 0;
        current = current.replace(re, () => { cnt++; return ph; });
        if (cnt > 0) {
            total += cnt;
            hits.set(i + 1, cnt);
            if (sink !== undefined)
                sink(rule, cnt);
        }
    });
    const result = { text: current, count: total };
    if (usesNumber && hits.size > 0)
        result.hits = [...hits.entries()].map(([n, count]) => ({ n, count }));
    return result;
}
/** 只数不改：一段文本里命中规则的总次数 */
export function countText(text, rules) {
    if (!rules || rules.length === 0 || text.length === 0)
        return 0;
    let total = 0;
    for (const rule of rules) {
        const re = ruleRegExp(rule);
        if (re === undefined)
            continue;
        const matched = text.match(re);
        if (matched !== null)
            total += matched.length;
    }
    return total;
}
/** 递归冻结替换产生的新值（平台要求消息/内容块不可变） */
function freezeDeep(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value)) {
        for (const item of value)
            freezeDeep(item);
        return Object.freeze(value);
    }
    for (const item of Object.values(value))
        freezeDeep(item);
    return Object.freeze(value);
}
/**
 * 非原地替换一组内容块（text / reasoning / tool-result 嵌套块 / tool-call 参数）。
 * 无命中时返回**原引用**与 count=0，调用方据此跳过；有命中时返回全新的冻结块。
 *
 * `tool-call` 的 `arguments` 是**原始 JSON 字符串**，替换时必须做 JSON 转义
 * （占位符里含 `"` 或 `\` 时否则会把参数弄成非法 JSON）。
 */
export function replaceBlocksCopy(blocks, rules, replaceWith, opts = {}) {
    if (!Array.isArray(blocks) || blocks.length === 0 || rules.length === 0) {
        return { blocks: blocks, count: 0 };
    }
    let total = 0;
    let changed = false;
    const out = [];
    for (const block of blocks) {
        if (block.type === 'text' || block.type === 'reasoning') {
            const r = replaceText(block.text, rules, replaceWith, opts.sink);
            if (r.count > 0) {
                changed = true;
                total += r.count;
                out.push(freezeDeep({ ...block, text: r.text }));
            }
            else
                out.push(block);
            continue;
        }
        if (block.type === 'tool-result' && Array.isArray(block.content)) {
            const inner = replaceBlocksCopy(block.content, rules, replaceWith, opts);
            if (inner.count > 0) {
                changed = true;
                total += inner.count;
                out.push(freezeDeep({ ...block, content: inner.blocks }));
            }
            else
                out.push(block);
            continue;
        }
        if (block.type === 'tool-call' && opts.toolCallArguments === true) {
            const r = replaceText(block.arguments, rules, jsonSafeReplacement(replaceWith), opts.sink);
            if (r.count > 0) {
                changed = true;
                total += r.count;
                out.push(freezeDeep({ ...block, arguments: r.text }));
            }
            else
                out.push(block);
            continue;
        }
        out.push(block);
    }
    return changed ? { blocks: freezeDeep(out), count: total } : { blocks: blocks, count: 0 };
}
/** 把占位符转成可安全嵌进 JSON 字符串字面量的形式（`{n}` 模板原样保留） */
function jsonSafeReplacement(replaceWith) {
    const escaped = JSON.stringify(replaceWith);
    return escaped.slice(1, -1);
}
/**
 * 出网前清洗整份请求（v0.5.0）：messages（含 tool-call 参数）与 system 全部拷贝替换。
 * 不改动入参（请求是深冻结的），无命中时返回原对象与 count=0。
 * v0.7.0：可选 `sink(rule, count)` 用于规则级计数（同 replaceText）。
 */
export function scrubRequest(options, rules, replaceWith, sink) {
    if (!options || rules.length === 0)
        return { options, count: 0 };
    let total = 0;
    let messages = options.messages;
    if (Array.isArray(options.messages)) {
        let changed = false;
        const next = options.messages.map((m) => {
            const r = replaceMessageCopy(m, rules, replaceWith, { toolCallArguments: true, ...(sink === undefined ? {} : { sink }) });
            if (r.count > 0) {
                changed = true;
                total += r.count;
            }
            return r.message;
        });
        if (changed)
            messages = freezeDeep(next);
    }
    let system = options.system;
    if (typeof options.system === 'string') {
        const r = replaceText(options.system, rules, replaceWith, sink);
        if (r.count > 0) {
            total += r.count;
            system = r.text;
        }
    }
    if (total === 0)
        return { options, count: 0 };
    const cleaned = { ...options, messages };
    if (system !== options.system)
        cleaned.system = system;
    return { options: Object.freeze(cleaned), count: total };
}
/** 非原地替换一条消息：无命中返回原消息（同一引用），有命中返回保留 id 的新冻结消息 */
export function replaceMessageCopy(msg, rules, replaceWith, opts = {}) {
    if (!msg || !Array.isArray(msg.content))
        return { message: msg, count: 0 };
    const r = replaceBlocksCopy(msg.content, rules, replaceWith, opts);
    if (r.count === 0)
        return { message: msg, count: 0 };
    return { message: freezeDeep({ ...msg, content: r.blocks }), count: r.count };
}
/** 只数不改：一组内容块里的命中数（含 tool-call 参数的原始 JSON 串） */
export function scanBlocks(blocks, rules) {
    if (!Array.isArray(blocks) || rules.length === 0)
        return 0;
    let total = 0;
    for (const block of blocks) {
        if (block.type === 'text' || block.type === 'reasoning')
            total += countText(block.text, rules);
        else if (block.type === 'tool-call')
            total += countText(block.arguments, rules);
        else if (block.type === 'tool-result' && Array.isArray(block.content))
            total += scanBlocks(block.content, rules);
    }
    return total;
}
/** 只数不改：整个请求（messages + system）里的命中数 */
export function scanOptions(options, rules) {
    if (!options || rules.length === 0)
        return 0;
    let total = 0;
    if (Array.isArray(options.messages))
        for (const m of options.messages)
            total += scanBlocks(m.content, rules);
    if (typeof options.system === 'string')
        total += countText(options.system, rules);
    return total;
}
/** 按模型取规则（模型键精确 → 前缀模式最长优先 → 空；显式空精确键阻止回落） */
function resolveModelRules(models, m) {
    const exact = models[m];
    if (exact)
        return exact;
    let best = null;
    let bestLen = -1;
    for (const [key, rules] of Object.entries(models)) {
        if (!key.endsWith('*'))
            continue;
        const prefix = key.slice(0, -1).toLowerCase();
        if (prefix && m.startsWith(prefix) && prefix.length > bestLen) {
            best = rules;
            bestLen = prefix.length;
        }
    }
    return best ?? [];
}
/** 一个 provider 条目的生效规则：基础 ∪ 命中的模型规则 */
function entryRules(entry, model) {
    const m = (model ?? '').toLowerCase();
    const base = entry.base ?? [];
    if (!m)
        return base;
    return [...base, ...resolveModelRules(entry.models ?? {}, m)];
}
/**
 * 按 Provider ID（+ 可选模型）取专属规则：
 *  1. providers.<id> 精确（值可为数组=旧形态，或 { _ 基础, models 按模型 }）
 *  2. providers.<前缀>* 前缀模式（多命中取最长前缀）
 *  3. 条目内再按模型：models.<model> 精确 → models.<前缀>* 最长前缀
 * 显式写了精确键（即使为空列表）即命中并停止，不回落到前缀模式。
 * 返回 [] 表示无专属规则（调用方仍会叠加 global）。
 */
export function providerRules(bl, provider, model) {
    const p = (provider ?? '').toLowerCase();
    if (!p)
        return [];
    const exact = bl.byProvider[p];
    if (exact)
        return entryRules(exact, model);
    let best = null;
    let bestLen = -1;
    for (const [key, entry] of Object.entries(bl.byProvider)) {
        if (!key.endsWith('*'))
            continue;
        const prefix = key.slice(0, -1).toLowerCase();
        if (prefix && p.startsWith(prefix) && prefix.length > bestLen) {
            best = entry;
            bestLen = prefix.length;
        }
    }
    return best ? entryRules(best, model) : [];
}
/** 取某 provider（+模型）的生效规则（全局 ∪ 该 Provider ID/模型专属规则） */
export function rulesFor(bl, provider, model) {
    return [...bl.global, ...providerRules(bl, provider, model)];
}
/**
 * 规则编号表（v0.7.0）：去重后按**出现顺序**编号——global 在前，随后 providers
 * 按文件顺序（每个 provider 先 `_` 基础规则、再 `models` 里的各模型）。
 * 同一段规则文本在文件里出现多次时只占一个编号，计数合并到首次出现的位置。
 * 编号只用于把「哪条规则在起作用」说清楚，条目文本本身不外发。
 */
export function ruleIndex(bl) {
    const order = [];
    const scopeOf = new Map();
    const add = (rule, scope) => {
        if (!scopeOf.has(rule)) {
            scopeOf.set(rule, scope);
            order.push(rule);
        }
    };
    for (const r of bl.global)
        add(r, 'global');
    for (const [id, e] of Object.entries(bl.byProvider)) {
        for (const r of e.base)
            add(r, 'providers.' + id);
        for (const [mk, arr] of Object.entries(e.models))
            for (const r of arr)
                add(r, 'providers.' + id + '/models.' + mk);
    }
    return { order, scopeOf };
}
export function apply(ctx, config) {
    const logger = ctx.logger('dsh-sensitive-replace');
    const blocklistPath = config.blocklistPath || join(dshHome(), 'sensitive-blocklist.yaml');
    let cachedBl = null;
    /** 上次已经打过日志的屏蔽表版本（mtime|警告数|解析错误），避免每次调用都刷屏 */
    let loggedStamp = null;
    /** 取当前屏蔽表（热重载）；内容一变就把解析错误与形态警告打进运行日志（v0.7.0） */
    function currentBlocklist() {
        cachedBl = loadBlocklist(blocklistPath, cachedBl);
        const stamp = String(cachedBl.mtimeMs ?? 0) + '|' + (cachedBl.warnings?.length ?? 0) + '|' + (cachedBl.parseError ?? '');
        if (stamp !== loggedStamp) {
            loggedStamp = stamp;
            if (cachedBl.parseError)
                logger.error('屏蔽表解析失败（自动面空转，请修文档）: ' + cachedBl.parseError);
            for (const w of cachedBl.warnings ?? [])
                logger.warn('屏蔽表警告: ' + w);
        }
        return cachedBl;
    }
    /** 每个 agent 最近一次解析出的路由，用于在进上下文阶段套用 provider/model 专属规则 */
    const routes = new Map();
    const agentKey = (agent) => agent === undefined || agent === null ? undefined : String(agent.id);
    const routeOf = (agent) => {
        const key = agentKey(agent);
        return key === undefined ? undefined : routes.get(key);
    };
    /** 进上下文阶段能套用的规则：路由已知则 global ∪ 专属，未知则只 global */
    const ingestRules = (agent) => {
        const route = routeOf(agent);
        const bl = currentBlocklist();
        return {
            rules: rulesFor(bl, route?.provider, route?.model),
            ...(route === undefined ? {} : { provider: route.provider, ...(route.model === undefined ? {} : { model: route.model }) }),
            routed: route !== undefined,
        };
    };
    // ---------- 工具面 ----------
    ctx.tools.register(defineTool({
        name: 'replace_sensitive',
        description: '按屏蔽表（敏感字符替换文档：全局 + 按 Provider ID（+模型）分类）清洗文本中的敏感字符，命中替换为占位符。用于官方源防崩：网页抓取/外部文本进入上下文前先清洗，规避 DeepSeek 官方 Content Exists Risk 400。provider 缺省只套「全局」规则；指定 Provider ID（如 deepseek-official / arkcli-agent-plan）与 model 时叠加对应专属规则（支持键尾 * 前缀模式、re: 正则条目）。replaceWith 含 {n} 时输出带规则序号的占位符便于还原。返回清洗后文本、替换计数与命中明细。',
        parameters: {
            text: { type: 'string', description: '待清洗文本', required: true },
            provider: { type: 'string', description: 'Provider ID（可选）：DSH 的 provider 路由 id（如 deepseek-official / arkcli-agent-plan）；套用该来源专属规则（叠加全局）' },
            model: { type: 'string', description: '模型（可选）：套用该 provider 下 models.<model> 的专属规则（叠加基础与全局）' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    removed: { type: 'number' },
                    lengthBefore: { type: 'number' },
                    lengthAfter: { type: 'number' },
                    cleaned: { type: 'string' },
                    rulesGlobal: { type: 'number' },
                    rulesProvider: { type: 'number' },
                    hits: {
                        type: 'array',
                        items: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                n: { type: 'number' },
                                count: { type: 'number' },
                            },
                        },
                    },
                    note: { type: 'string' },
                },
            },
            render: (_a, v) => [{
                    type: 'text',
                    text: v.ok
                        ? '已替换敏感字符 ' + v.removed + ' 处（' + v.lengthBefore + '→' + v.lengthAfter + ' 字符；规则 全局' + v.rulesGlobal + '+来源' + v.rulesProvider + (v.hits ? '；命中 ' + v.hits.map((h) => '#' + h.n + 'x' + h.count).join(', ') : '') + '）'
                        : 'replace_sensitive 失败: ' + v.note,
                }],
        },
        async execute(args) {
            if (!config.enabled)
                return { ok: false, note: '插件已禁用' };
            try {
                const bl = currentBlocklist();
                const rules = rulesFor(bl, args.provider, args.model);
                const r = replaceText(args.text ?? '', rules, config.replaceWith);
                const result = {
                    ok: true,
                    removed: r.count,
                    lengthBefore: (args.text ?? '').length,
                    lengthAfter: r.text.length,
                    cleaned: r.text,
                    rulesGlobal: bl.global.length,
                    rulesProvider: providerRules(bl, args.provider, args.model).length,
                };
                // note/hits 只在有内容时出现：undefined 键违反平台 lossless-JSON 契约，
                // 整键删除而非塞 undefined/空串
                if (bl.parseError)
                    result.note = bl.parseError;
                else if (bl.warnings && bl.warnings.length > 0)
                    result.note = '警告: ' + bl.warnings.join('; ');
                if (r.hits && r.hits.length > 0)
                    result.hits = r.hits;
                return result;
            }
            catch (err) {
                return { ok: false, note: String(err) };
            }
        },
    }));
    // ---------- 运行统计（只读诊断，供 sensitive_replace_status 查看）----------
    /** 规则级命中计数（键=规则文本；只在本进程内做诊断，文本绝不外发） */
    const ruleHits = new Map();
    /** 交给 replaceText 的计数回调：只累计次数与最近命中时间 */
    const countHit = (rule, n) => {
        const e = ruleHits.get(rule) ?? { count: 0, lastAt: 0 };
        e.count += n;
        e.lastAt = Date.now();
        ruleHits.set(rule, e);
    };
    /** 把内部计数投影成可外发形态：编号 + 位置 + 次数 + 距今秒数，不含任何规则文本 */
    function ruleHitReport() {
        const { order, scopeOf } = ruleIndex(currentBlocklist());
        const index = new Map(order.map((r, i) => [r, i + 1]));
        const now = Date.now();
        const rows = ruleHits.size === 0 ? [] : [...ruleHits.entries()].map(([rule, e]) => {
            const n = index.get(rule);
            const scope = rule === AGGRESSIVE_RULE
                ? 'aggressive（400 加硬规则）'
                : n === undefined ? '已从屏蔽表移除' : (scopeOf.get(rule) ?? '未知位置');
            return { n: n ?? 0, scope, count: e.count, lastAgoS: Math.max(0, Math.round((now - (e.lastAt || now)) / 1000)) };
        });
        rows.sort((a, b) => (a.n === 0 ? Number.MAX_SAFE_INTEGER : a.n) - (b.n === 0 ? Number.MAX_SAFE_INTEGER : b.n));
        return rows;
    }
    const stats = {
        ingestMessages: 0,
        ingestToolResults: 0,
        dispatchScrubs: 0,
        dispatchLast: 0,
        dispatchCharges: 0,
        recoveries: 0,
        last400: '',
    };
    /** 加硬清洗（400 之后）截止时间 */
    let aggressiveUntil = 0;
    /** 400 自动恢复的滑动窗口记录 */
    let recoveryTimes = [];
    ctx.tools.register(defineTool({
        name: 'sensitive_replace_status',
        description: '查看 dsh-sensitive-replace 的运行状态与计数（只读诊断）：规则数、屏蔽表是否存在、进上下文清洗次数、出网前清洗次数与最近一次替换处数、是否处于加硬清洗、400 自动恢复次数等。只返回计数与开关状态，不返回任何屏蔽词内容。用于确认"出网前清洗"是否真的在工作。',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    version: { type: 'string' },
                    enabled: { type: 'boolean' },
                    blocklistPath: { type: 'string' },
                    blocklistExists: { type: 'boolean' },
                    rulesGlobal: { type: 'number' },
                    rulesProviders: { type: 'number' },
                    parseError: { type: 'string' },
                    warnings: { type: 'number' },
                    autoReplace: { type: 'boolean' },
                    dispatchScrub: { type: 'boolean' },
                    scrubDurableRequests: { type: 'boolean' },
                    recoverOn400: { type: 'boolean' },
                    aggressive: { type: 'boolean' },
                    ingestMessages: { type: 'number' },
                    ingestToolResults: { type: 'number' },
                    dispatchScrubs: { type: 'number' },
                    dispatchLast: { type: 'number' },
                    dispatchCharges: { type: 'number' },
                    recoveries: { type: 'number' },
                    last400: { type: 'string' },
                    ruleHits: {
                        type: 'array',
                        items: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                n: { type: 'number' },
                                scope: { type: 'string' },
                                count: { type: 'number' },
                                lastAgoS: { type: 'number' },
                            },
                        },
                    },
                    warningList: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (_a, v) => [{
                    type: 'text',
                    text: 'dsh-sensitive-replace v' + v.version + '：' + (v.enabled ? '启用' : '禁用')
                        + '｜规则 全局' + v.rulesGlobal + '/来源' + v.rulesProviders + ' 组'
                        + '｜屏蔽表 ' + (v.blocklistExists ? '存在' : '缺失（未建表）')
                        + '｜进上下文清洗 ' + (v.ingestMessages + v.ingestToolResults) + ' 次'
                        + '｜出网前清洗 ' + v.dispatchScrubs + ' 次（累计替换 ' + v.dispatchCharges + ' 处，最近 ' + v.dispatchLast + ' 处'
                        + (v.dispatchScrub ? (v.scrubDurableRequests ? '；含日志重建请求' : '；仅手搓请求') : '；关') + '）'
                        + '｜规则命中 ' + (v.ruleHits.length === 0 ? '暂无' : v.ruleHits.slice(0, 6).map((h) => '#' + (h.n || '-') + 'x' + h.count).join(' ') + (v.ruleHits.length > 6 ? ' …共' + v.ruleHits.length + '条' : ''))
                        + (v.warningList.length > 0 ? '｜⚠ 屏蔽表警告 ' + v.warningList.length + ' 条' : '')
                        + (v.aggressive ? '｜⚠ 加硬清洗进行中' : '')
                        + (v.recoveries > 0 ? '｜400 自动恢复 ' + v.recoveries + ' 次（最近 ' + v.last400 + '）' : '')
                        + (v.parseError ? '｜⚠ ' + v.parseError : ''),
                }],
        },
        async execute() {
            const bl = currentBlocklist();
            return {
                ok: true,
                version: PLUGIN_VERSION,
                enabled: config.enabled,
                blocklistPath,
                blocklistExists: bl.exists === true,
                rulesGlobal: bl.global.length,
                rulesProviders: Object.keys(bl.byProvider).length,
                warnings: bl.warnings?.length ?? 0,
                warningList: [...(bl.warnings ?? [])],
                ruleHits: ruleHitReport(),
                autoReplace: config.autoReplace,
                dispatchScrub: config.dispatchScrub,
                scrubDurableRequests: config.scrubDurableRequests,
                recoverOn400: config.recoverOn400,
                aggressive: config.aggressive || Date.now() < aggressiveUntil,
                ingestMessages: stats.ingestMessages,
                ingestToolResults: stats.ingestToolResults,
                dispatchScrubs: stats.dispatchScrubs,
                dispatchLast: stats.dispatchLast,
                dispatchCharges: stats.dispatchCharges,
                recoveries: stats.recoveries,
                last400: stats.last400,
                ...(bl.parseError === undefined ? {} : { parseError: bl.parseError }),
            };
        },
    }));
    // ---------- 自动面 · 进上下文（v0.4.1）----------
    if (config.enabled && config.autoReplace) {
        // 路由追踪：agent/request 瀑布返回最终调用配置（只读观察，原样返回）
        ctx.on('agent/request', async (payload, next) => {
            const call = await next();
            try {
                const key = agentKey(payload?.agent);
                if (key !== undefined) {
                    routes.set(key, {
                        provider: call.provider,
                        ...(typeof call.model === 'string' ? { model: call.model } : {}),
                    });
                }
            }
            catch { /* 追踪失败绝不影响请求 */ }
            return call;
        });
        // 会话退场时清掉路由缓存，避免长进程里累积
        ctx.on('agent/disposed', (payload) => {
            const key = agentKey(payload?.agent);
            if (key !== undefined)
                routes.delete(key);
        });
        // 1) 用户/插件消息进入步骤前清洗（命中内容不会进入会话日志）
        ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next();
            try {
                if (decision.kind !== 'enter')
                    return decision;
                const { rules, provider, model, routed } = ingestRules(payload.agent);
                if (rules.length === 0)
                    return decision;
                let total = 0;
                let changed = false;
                const messages = decision.messages.map((m) => {
                    const r = replaceMessageCopy(m, rules, config.replaceWith, { sink: countHit });
                    if (r.count > 0) {
                        total += r.count;
                        changed = true;
                    }
                    return r.message;
                });
                if (!changed)
                    return decision;
                stats.ingestMessages += total;
                logger.warn('消息进入上下文前替换 ' + total + ' 处命中字符（provider=' + (provider ?? '未知，只套 global') + (model === undefined ? '' : ' model=' + model) + (routed ? '' : '；路由未定，仅 global 规则') + '）');
                return { ...decision, messages };
            }
            catch (err) {
                logger.error('sensitive-replace pre-step 清洗失败（本次跳过，原文进入上下文）: ' + String(err));
                return decision;
            }
        });
        // 2) 工具结果落入日志前清洗（网页抓取/搜索/读文件/命令输出等外部文本）
        ctx.on('tools/post-execute', async (exec, result, next) => {
            const decision = await next();
            try {
                if (decision.kind !== 'accept')
                    return decision;
                // 替换 value 的形态会由注册表自行重渲染 content，此处不能再改 content
                if (Object.hasOwn(decision, 'value'))
                    return decision;
                const accepted = decision;
                const source = Array.isArray(accepted.content) ? accepted.content : result?.content;
                if (!Array.isArray(source))
                    return decision;
                const { rules, provider, model, routed } = ingestRules(exec.agent);
                if (rules.length === 0)
                    return decision;
                const r = replaceBlocksCopy(source, rules, config.replaceWith, { sink: countHit });
                if (r.count === 0)
                    return decision;
                stats.ingestToolResults += r.count;
                logger.warn('工具结果进入上下文前替换 ' + r.count + ' 处命中字符（tool=' + exec.name + ' provider=' + (provider ?? '未知，只套 global') + (model === undefined ? '' : ' model=' + model) + (routed ? '' : '；路由未定，仅 global 规则') + '）');
                return { ...accepted, content: r.blocks };
            }
            catch (err) {
                logger.error('sensitive-replace post-execute 清洗失败（本次跳过，原文进入上下文）: ' + String(err));
                return decision;
            }
        });
    }
    // ---------- 自动面 · 出网前（v0.5.0 / v0.6.0 对齐 rc2）----------
    if (config.enabled && (config.dispatchScrub || config.detectUnfiltered)) {
        /** 我们自己重发的副本，避免再次进入清洗分支（防递归） */
        const redispatched = new WeakSet();
        /** 适配器边界降级的提示只记一次，避免每次命中都刷屏 */
        let boundaryFallbackWarned = false;
        /**
         * 把清洗后的请求续到适配器边界。
         *
         * rc2 起 dsh-llm 把 `adapterStream` / `streamWithRegistration` 标为 private
         * （运行时仍在），公开入口只剩 `stream()`，而 `stream()` 会重新进入
         * `llm/stream` 瀑布，让其它监听器（标题观察、检查点 flush…）对同一次调用
         * 重复观察。所以优先直连适配器边界；不可用时退回 `stream()`，由上面的
         * WeakSet 防递归。两条路径都不会改写原请求（它对 loop 请求是深冻结的）。
         */
        const continueToAdapter = (llm, cleaned) => {
            if (typeof llm.adapterStream === 'function')
                return llm.adapterStream(cleaned, undefined);
            if (!boundaryFallbackWarned) {
                boundaryFallbackWarned = true;
                logger.warn('llm.adapterStream 不可用 → 退回 llm.stream()：会重新进入 llm/stream 瀑布，其它监听器可能重复观察本次调用');
            }
            return llm.stream(cleaned);
        };
        ctx.on('llm/stream', (options, next) => {
            try {
                const bl = currentBlocklist();
                const aggressive = config.aggressive || Date.now() < aggressiveUntil;
                const rules = rulesFor(bl, options.provider, options.model);
                const effective = aggressive ? [...rules, AGGRESSIVE_RULE] : rules;
                if (effective.length === 0)
                    return next();
                // rc2 起，带 sessionId 的请求是「由会话日志纯函数重建」的请求：
                // dsh-agent-loop 的 log-reconstruction 不变量声明这类请求的监听器
                // 只读不改写。dispatchScrub 是刻意的应急网——把清洗后的副本直送适配器
                // 边界，让本次出网内容与日志暂时不一致（这正是屏蔽的本意）。要严格守约
                // 就设 config.scrubDurableRequests=false，只保留只读扫描告警。
                const durable = options.sessionId !== undefined;
                if (config.dispatchScrub && (config.scrubDurableRequests || !durable) && !redispatched.has(options)) {
                    const scrub = scrubRequest(options, effective, config.replaceWith, countHit);
                    if (scrub.count > 0) {
                        redispatched.add(scrub.options);
                        stats.dispatchScrubs += 1;
                        stats.dispatchLast = scrub.count;
                        stats.dispatchCharges += scrub.count;
                        logger.warn('请求出网前替换 ' + scrub.count + ' 处（含历史消息 / tool-call 参数）'
                            + (aggressive ? '，加硬清洗进行中（额外剥离 emoji/符号）' : '')
                            + (durable ? '，日志重建请求：本次为绕过重建校验的应急改写' : '')
                            + ' provider=' + options.provider + ' model=' + options.model);
                        const llm = ctx.get('llm');
                        if (llm === undefined)
                            return next();
                        return continueToAdapter(llm, scrub.options);
                    }
                }
                if (config.detectUnfiltered) {
                    const n = scanOptions(options, effective);
                    if (n > 0) {
                        logger.warn('出网前仍有 ' + n + ' 处命中屏蔽词未被替换（provider=' + options.provider + ' model=' + options.model + '）：这些内容进入上下文时未被清洗，或来自历史日志 / 模型自身输出');
                    }
                }
            }
            catch (err) {
                logger.error('sensitive-replace 出网前清洗失败（按原请求发送）: ' + String(err));
            }
            return next();
        });
    }
    // ---------- 400 自动恢复（v0.5.0）----------
    if (config.enabled && config.recoverOn400) {
        ctx.on('agent/request-error', async (payload, next) => {
            try {
                const failure = payload?.failure;
                const is400 = failure?.status === 400 || failure?.code === 'INVALID_REQUEST';
                if (!is400)
                    return next();
                const now = Date.now();
                recoveryTimes = recoveryTimes.filter((t) => now - t < RECOVERY_WINDOW_MS);
                if (recoveryTimes.length >= config.maxRecoveries) {
                    logger.warn('400 自动恢复已达上限（' + config.maxRecoveries + ' 次 / 10 分钟），本次不重试；把触发内容加进屏蔽表后重发即可');
                    return next();
                }
                recoveryTimes.push(now);
                aggressiveUntil = now + config.aggressiveMs;
                stats.recoveries += 1;
                stats.last400 = String(failure?.code ?? '400');
                logger.warn('模型返回 400（' + (failure?.code ?? '?') + (failure?.message ? '：' + failure.message : '')
                    + '）→ 开启加硬清洗（规则 + 剥离 emoji/符号）并重试，上下文与对话保持连续');
                return { kind: 'retry' };
            }
            catch (err) {
                logger.error('sensitive-replace 400 恢复失败: ' + String(err));
                return next();
            }
        });
    }
    ctx.effect(() => {
        // v0.7.1：首次启动发现屏蔽表不存在 → 建一张空表模板（不覆盖、失败不抛）
        let createdNote = '';
        if (config.createBlocklistIfMissing !== false) {
            const r = ensureBlocklist(blocklistPath);
            if (r.created) {
                createdNote = '；已自动创建空表模板，把要屏蔽的字符填进去即生效';
                logger.info('屏蔽表不存在 → 已创建空表模板: ' + blocklistPath);
            }
            else if (r.reason !== 'exists') {
                logger.warn('屏蔽表不存在且自动创建失败（' + r.reason + '）: ' + blocklistPath + '；自动面空转，请手动创建该文件');
            }
        }
        const bl = currentBlocklist();
        const note = !bl.exists ? '（屏蔽表不存在，自动面空转：' + blocklistPath + '）' + createdNote : bl.parseError ? '⚠ ' + bl.parseError + '（自动面空转，请修文档）' : '规则 全局' + bl.global.length + ' / 来源 ' + Object.keys(bl.byProvider).length + ' 组' + (bl.warnings && bl.warnings.length ? '；⚠ ' + bl.warnings.length + ' 条屏蔽表警告（逐条见上）' : '');
        logger.info('ready autoReplace=' + (config.enabled && config.autoReplace)
            + ' dispatchScrub=' + (config.enabled && config.dispatchScrub)
            + ' detectUnfiltered=' + (config.enabled && config.detectUnfiltered)
            + ' recoverOn400=' + (config.enabled && config.recoverOn400) + ' ' + note);
        return () => { };
    });
}
