/**
 * dsh-sensitive-replace — 敏感字符在「进上下文 + 出网前」两个关口自动替换（v0.6.2）
 *
 * 背景：DeepSeek 官方 API 内容审核对特定字符（部分 emoji 码位组合等）硬命中——
 * 请求上下文只要含它即返回 400 "Content Exists Risk"。本插件按
 * 用户自行维护的「屏蔽表」文档，在内容**进入会话上下文（即进入模型请求）之前**
 * 把命中字符替换为占位符，从源头防崩。
 *
 * 屏蔽表文档（默认 $DSH_HOME/sensitive-blocklist.yaml，config.blocklistPath 可覆盖，
 * 用户手动维护，mtime 变化即热重载，无需重启 web）——YAML 结构化：
 *
 *   # 敏感字符屏蔽表（YAML，支持注释）
 *   global:                    # 对任何 Provider ID 生效
 *     - '\u{1F600}'            # 支持直接粘字符或 \u{XXXX} 码位（单引号或裸写）
 *   providers:                 # 按 Provider ID（键 = DSH 的 provider 路由 id）
 *     deepseek-official: [...] #   精确匹配；键尾带 '*' 为前缀模式（一族 id 共用）
 *     example-provider-cn:     #   对象形态：_ = 基础规则，models = 按模型细分
 *       _: [...]
 *       models:
 *         'model-a-20260101': [...]
 *         'vendor/*': [...]                 # 模型前缀模式
 *
 * 匹配模式：三级链 —— global（任何 provider）
 *   → providers.<id>（Provider ID 精确 → 前缀 '*' 最长优先；值可为数组=旧形态
 *     或对象 { _ 基础, models 按模型 }）
 *   → models.<model>（模型精确 → 前缀 '*' 最长优先）。
 *   Provider ID = 请求 options.provider（DSH 的 provider 路由 id，如
 *   deepseek-official），不是显示名也不是厂商名。
 * 条目写法：普通字符串 = 字面量；'re:...' = 正则（无效正则跳过并记警告）；
 * replaceWith 含 {n} 时替换为带规则序号（1 起：global 在前、当前 provider 在后）
 * 的占位符（如 [BLOCKED:3]），便于按屏蔽表还原原文。
 *
 * 值写法：单引号 '...'（内容原样）或裸写；不要用双引号包 \u{XXXX}（YAML 会当转义）。
 *
 * ── v0.4.1 的关键修正（自动面为什么换了落点）────────────────────────────────
 * v0.4.0 的自动面挂在 `llm/stream` 瀑布里原地改写 `options.messages`。但本平台
 * 的消息是**深冻结**的：dsh-llm 的消息工厂 `createMessage → freezeMessage →
 * deepFreeze(structuredClone(...))`，dsh-agent-loop 构请求时还会再对每条消息
 * `deepFreeze()` 并 `Object.freeze(boundaryMessages)`。对冻结对象赋值在严格模式下
 * 抛 TypeError —— v0.4.0 把它 catch 掉后照常 next()，结果是**命中时既不替换也不拦，
 * 原文照样出网**（自动面静默空转）。且 `next()` 闭包捕获的就是原 options，无法
 * 把"清洗后的副本"交给下一环节。
 *
 * 因此 v0.4.1 把自动面改挂到本平台**支持替换内容**的两个瀑布（都在内容被写入会话
 * 日志之前，所以替换结果会持久生效、后续每次请求都干净）：
 *   1. `agent/pre-step`  —— 用户/插件消息进入步骤前，替换 `decision.messages`；
 *   2. `tools/post-execute` —— 工具结果（网页抓取/搜索/读文件/命令输出等外部文本）
 *      落入日志前，返回 `{ kind:'accept', content: 清洗后的块 }`。
 * 另外保留 `llm/stream` 监听，但**只读扫描**（不再尝试改写）：若出网请求里仍有命中，
 * 记一条警告，便于发现"进上下文时没被清洗"的漏网内容（历史日志、tool-call 参数等）。
 *
 * 路由追踪：`agent/pre-step` / `tools/post-execute` 的载荷里没有 provider/model，
 * 所以插件监听 `agent/request` 瀑布，按 agent 记住最近一次解析出的 provider/model，
 * 供清洗时套用专属规则；首次请求之前尚不知道路由，此时只套 global。
 *
 * 已知边界（详见 README「能力与边界」）：模型自己产出的文本、tool-call 参数、
 * 系统提示词装配结果不走上面两个钩子，不会被替换（出网前扫描会告警）。
 *
 * ── v0.5.0 新增：出网前清洗 + 400 自动恢复 ────────────────────────────────
 * v0.4.1 只清洗「新进入上下文」的内容，已经躺在会话日志里的（历史消息、模型自己
 * 写过的内容、tool-call 参数）永远洗不掉——请求是从日志派生的，所以它们照样出网。
 *
 * v0.5.0 增加最后一道关口 `dispatchScrub`：在 `llm/stream` 瀑布里把整份请求
 * **深拷贝**（请求本身是深冻结的，不能原地改）并替换命中内容后，直接续到适配器
 * 边界（`llm.adapterStream(clean)`；不可用时退回 `llm.stream(clean)`，用 WeakSet
 * 防递归重进）。因为不重进瀑布，其它 `llm/stream` 监听器（标题观察、检查点 flush）
 * 不会被同一次调用重复触发。
 *
 * 外加 `recoverOn400`：模型返回 400（code=INVALID_REQUEST）时，开启「加硬清洗」
 * —— 在规则之外额外剥离 emoji / 旗帜 / 杂项符号一类码位（`AGGRESSIVE_RULE`）——
 * 并返回 `{kind:'retry'}`。循环 retry 时会**重新从日志派生请求**，于是这一次就
 * 能发出去，对话与上下文保持连续（不需要新建会话）。重试次数在 10 分钟窗口内封顶，
 * 防止 400 循环。
 *
 * 安全约定：源码/日志/输出不携带屏蔽字符字形，只以码位与计数出现；替换位默认
 * "[BLOCKED]" 占位（纯 ASCII），明示内容被屏蔽而非静默删除。**本仓库任何文件
 * （含 tests / samples / 文档示例）都不含真实屏蔽词**，一律用编造占位符。
 *
 * ── v0.6.2：仅打包与文档（无行为变化）─────────────────────────────────────
 * 仓库公开前的清理：测试与文档示例里的真实屏蔽表内容 / 本机标识一律换成编造的
 * 占位符（本仓库任何文件都不含真实屏蔽词）；`npm test` 修好；补 LICENSE /
 * .gitignore / 包元数据。
 *
 * ── v0.6.1：对齐 DSH 0.2.0-rc.x（去掉跨版本豁免）───────────────────────────
 * 1. peerDependencies 放宽为 `^0.1.0-rc.6 || ^0.2.0-rc.1`，因此 0.2.0-rc.x 下
 *    不再需要 `dsh plugin allow-version` 的精确版本豁免（豁免意味着包自身声明的
 *    兼容范围与运行时不符，属于要清的债）。
 * 2. rc2 把 `llm.adapterStream` / `streamWithRegistration` 标为 private（运行时仍在），
 *    公开入口只剩会重进瀑布的 `llm.stream()`。出网前清洗因此改为显式的
 *    `continueToAdapter()`：优先直连适配器边界，缺失时退回 `llm.stream()` 并只告警一次。
 * 3. rc2 的 `dsh-agent-loop` 新增 log-reconstruction 不变量：带 `sessionId` 的
 *    **日志重建请求**由日志纯函数派生，"listeners read it, never rewrite it"。
 *    dispatchScrub 对这类请求属于刻意的应急改写，新增 `scrubDurableRequests`
 *    （默认 true＝保留 v0.5.0 行为）供严格守约时关闭，只留只读扫描告警。
 * 4. `sensitive_replace_status` 现在返回 `version` / `scrubDurableRequests`，
 *    可直接确认运行时到底加载了哪一份构建。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
export declare const name = "agent-sensitive-replace";
export declare const inject: readonly ["tools"];
/** 本构建版本，随 package.json 同步；经 sensitive_replace_status 暴露 */
export declare const PLUGIN_VERSION = "0.6.2";
export interface Config {
    /** 插件总开关 */
    enabled: boolean;
    /** 自动清洗：内容进入会话上下文（进日志）前按规则替换 */
    autoReplace: boolean;
    /** 出网前清洗（v0.5.0）：在 `llm/stream` 瀑布里把**整份请求**（含历史消息、模型自己写过的内容、tool-call 参数）拷贝替换后再交给适配器 */
    dispatchScrub: boolean;
    /**
     * v0.6.0：是否也清洗「从会话日志重建」的请求（rc2 起带 sessionId 的请求）。
     * rc2 的不变量声明这类请求只读不改写；默认 true 保留 v0.5.0 的应急改写，
     * 设为 false 则严格守约（只留进上下文清洗 + 只读告警）。
     */
    scrubDurableRequests: boolean;
    /** 出网前只读扫描：未开启 dispatchScrub 时，仍有命中就记警告（不改写） */
    detectUnfiltered: boolean;
    /** 400 自动恢复（v0.5.0）：捕获 400 后开启加硬清洗并重试一次，保持对话连续 */
    recoverOn400: boolean;
    /** 加硬清洗的持续时间（ms），超时自动关闭 */
    aggressiveMs: number;
    /** 常开加硬清洗（不等 400 也额外剥离 emoji / 符号） */
    aggressive: boolean;
    /** 滑动窗口内最多自动重试几次（防 400 循环） */
    maxRecoveries: number;
    /** 屏蔽表文档路径（缺省 $DSH_HOME/sensitive-blocklist.yaml） */
    blocklistPath: string;
    /** 替换占位符（默认 [BLOCKED]：明示内容被屏蔽，防思维链从空删除反推原文） */
    replaceWith: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    autoReplace: z<boolean, boolean>;
    dispatchScrub: z<boolean, boolean>;
    scrubDurableRequests: z<boolean, boolean>;
    detectUnfiltered: z<boolean, boolean>;
    recoverOn400: z<boolean, boolean>;
    aggressiveMs: z<number, number>;
    aggressive: z<boolean, boolean>;
    maxRecoveries: z<number, number>;
    blocklistPath: z<string, string>;
    replaceWith: z<string, string>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    autoReplace: z<boolean, boolean>;
    dispatchScrub: z<boolean, boolean>;
    scrubDurableRequests: z<boolean, boolean>;
    detectUnfiltered: z<boolean, boolean>;
    recoverOn400: z<boolean, boolean>;
    aggressiveMs: z<number, number>;
    aggressive: z<boolean, boolean>;
    maxRecoveries: z<number, number>;
    blocklistPath: z<string, string>;
    replaceWith: z<string, string>;
}>>;
/** 屏蔽表：全局规则 + 按 provider 的规则表 */
export interface Blocklist {
    global: string[];
    /** provider id（或前缀模式键，键尾 '*'）→ 规则条目 */
    byProvider: Record<string, ProviderEntry>;
    /** 文档 mtime（ms），用于热重载判断 */
    mtimeMs: number;
    /** 文档是否存在 */
    exists: boolean;
    /** YAML 解析错误（有错时表为空，自动面空转） */
    parseError?: string;
    /** 非致命警告（如 re: 正则无效被跳过） */
    warnings?: string[];
}
/** 单个 provider（或前缀族）的规则条目：基础列表 + 按模型分键（模型键尾 '*' 为前缀模式） */
export interface ProviderEntry {
    base: string[];
    models: Record<string, string[]>;
}
export declare function dshHome(): string;
/** 把 YAML 值里的 \u{XXXX} 码位转义替换成真实字符（也兼容 \uXXXX 形式） */
export declare function decodeEscapes(s: string): string;
/** 解析屏蔽表文档文本（YAML：{ global, providers }）→ Blocklist；provider 值可为数组或对象 */
export declare function parseBlocklist(text: string, mtimeMs: number): Blocklist;
/** 读屏蔽表文档（带 mtime 缓存，变化才重读） */
export declare function loadBlocklist(path: string, cached: Blocklist | null): Blocklist;
/**
 * 替换一段文本，返回新文本与命中次数（重复命中逐次计数）。
 * replaceWith 含 {n} 时按规则序号（1 起：global 在前、当前 provider 在后）编号，
 * 便于按屏蔽表还原原文；条目以 re: 开头按正则编译（无效正则跳过，不中断其它规则）。
 * hits 仅在启用编号且实际命中时返回（undefined 键不发——平台 lossless-JSON 契约）。
 */
export declare function replaceText(text: string, rules: string[], replaceWith: string): {
    text: string;
    count: number;
    hits?: Array<{
        n: number;
        count: number;
    }>;
};
/** 只数不改：一段文本里命中规则的总次数 */
export declare function countText(text: string, rules: string[]): number;
/**
 * 非原地替换一组内容块（text / reasoning / tool-result 嵌套块 / tool-call 参数）。
 * 无命中时返回**原引用**与 count=0，调用方据此跳过；有命中时返回全新的冻结块。
 *
 * `tool-call` 的 `arguments` 是**原始 JSON 字符串**，替换时必须做 JSON 转义
 * （占位符里含 `"` 或 `\` 时否则会把参数弄成非法 JSON）。
 */
export declare function replaceBlocksCopy(blocks: readonly ContentBlock[], rules: string[], replaceWith: string, opts?: {
    toolCallArguments?: boolean;
}): {
    blocks: ContentBlock[];
    count: number;
};
/**
 * 出网前清洗整份请求（v0.5.0）：messages（含 tool-call 参数）与 system 全部拷贝替换。
 * 不改动入参（请求是深冻结的），无命中时返回原对象与 count=0。
 */
export declare function scrubRequest(options: GenerateOptions, rules: string[], replaceWith: string): {
    options: GenerateOptions;
    count: number;
};
/** 非原地替换一条消息：无命中返回原消息（同一引用），有命中返回保留 id 的新冻结消息 */
export declare function replaceMessageCopy<T extends Message>(msg: T, rules: string[], replaceWith: string, opts?: {
    toolCallArguments?: boolean;
}): {
    message: T;
    count: number;
};
/** 只数不改：一组内容块里的命中数（含 tool-call 参数的原始 JSON 串） */
export declare function scanBlocks(blocks: readonly ContentBlock[], rules: string[]): number;
/** 只数不改：整个请求（messages + system）里的命中数 */
export declare function scanOptions(options: GenerateOptions, rules: string[]): number;
/**
 * 按 Provider ID（+ 可选模型）取专属规则：
 *  1. providers.<id> 精确（值可为数组=旧形态，或 { _ 基础, models 按模型 }）
 *  2. providers.<前缀>* 前缀模式（多命中取最长前缀）
 *  3. 条目内再按模型：models.<model> 精确 → models.<前缀>* 最长前缀
 * 显式写了精确键（即使为空列表）即命中并停止，不回落到前缀模式。
 * 返回 [] 表示无专属规则（调用方仍会叠加 global）。
 */
export declare function providerRules(bl: Blocklist, provider: string | undefined, model?: string | undefined): string[];
/** 取某 provider（+模型）的生效规则（全局 ∪ 该 Provider ID/模型专属规则） */
export declare function rulesFor(bl: Blocklist, provider: string | undefined, model?: string | undefined): string[];
export declare function apply(ctx: Context, config: Config): void;
