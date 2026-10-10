# dsh-sensitive-replace

敏感字符自动替换插件（v0.6.2）：按**用户自行维护的屏蔽表文档**，在**内容进入会话上下文之前**、以及**请求出网之前**两个关口把命中字符替换为占位符，
从源头规避 DeepSeek 官方 API 的 `Content Exists Risk` 400（根因：特定字符如部分 emoji 码位组合单独出现即命中官方审核）。
真出了 400 也能自动加硬清洗并重试，**对话与上下文保持连续**。

本包是一个 **DSH Profile Bundle**（`package.json` 里声明 `dsh.bundle.patch`），装进 profile 即自动挂载，不需要手写组合行。

---

## 安装

前置：DSH（`dsh` CLI 在 PATH 上）、profile 名（默认 `web`）。

### 方式一：从 npm / tarball 装（推荐）

```bash
# 已发布到 registry 时
dsh plugin --profile web add dsh-sensitive-replace

# 用本地构建产物 / tarball
dsh plugin --profile web add /abs/path/dsh-sensitive-replace-0.6.2.tgz
```

`dsh plugin` 本质是在 profile 目录里跑 pnpm，并在装完后把「声明了 `dsh.bundle` 的依赖」自动并入 `dsh.profile.bundles` 层栈。
本包声明了 `dsh.bundle.patch`，所以它自带的 `cordis.patch.yml` 会在下次启动 profile 时被组合进去，**无需手写插件行**。

装完重启该 profile（`dsh web` 的 profile 若开着 `patchReload: live`，改 patch 层可热生效；新增依赖仍建议重启一次）。

### 方式二：作为普通 npm 依赖 + 手写一行

不想用 bundle 机制时：

```bash
npm install /abs/path/dsh-sensitive-replace-0.6.2.tgz     # 或放进 profile 的依赖里
```

然后在 profile 的 `cordis.patch.yml`（用户 patch 层）里加一行：

```yaml
- insert:
    - id: sensitive-replace
      name: 'dsh-sensitive-replace'
```

### 之后：准备屏蔽表

把 `samples/sensitive-blocklist.example.yaml` 复制为 `$DSH_HOME/sensitive-blocklist.yaml`
（`$DSH_HOME` 默认 `~/.dsh`；Windows 上是 `%DSH_HOME%`，默认 `%USERPROFILE%\.dsh`；可用 config `blocklistPath` 覆盖）。

**保存即生效**：屏蔽表按文件 mtime 热重载，增删词无需重启。

### 配置覆盖

按行 id 覆盖（用户 patch 层在 bundle 层之后，后者生效）：

```yaml
- id: sensitive-replace
  config:
    enabled: true
    autoReplace: true
    detectUnfiltered: true
    blocklistPath: /abs/path/to/sensitive-blocklist.yaml
    replaceWith: '[BLOCKED]'
```

---

## 它到底在哪儿替换（三道关口）

DSH 里发往模型的请求是**深冻结**的：`dsh-llm` 的消息工厂 `createMessage → freezeMessage → deepFreeze(structuredClone(...))`，
`dsh-agent-loop` 构请求时还会对每条消息 `deepFreeze()` 并 `Object.freeze(boundaryMessages)`。
所以在 `llm/stream` 瀑布里**原地改写** `options.messages` 会抛 `TypeError`（严格模式）——v0.4.0 正是踩在这里：
异常被 catch 掉后照常出网，自动面静默空转。**但改成"拷贝一份再发"就完全可行**，这正是 v0.5.0 的第一道关口。

| # | 关口 | 钩子 | 覆盖 |
|---|---|---|---|
| 1 | 进上下文（消息） | `agent/pre-step` | 用户输入、steering、插件形成的进入步骤的消息 → 返回 `{ kind:'enter', messages: 替换后的消息 }`（**保留消息 id**，不原地改写） |
| 2 | 进上下文（工具结果） | `tools/post-execute` | 网页抓取/搜索、读文件、命令输出等外部文本（含 `tool-result` 嵌套块）→ 返回 `{ kind:'accept', content: 替换后的块 }` |
| 3 | **出网前（整份请求）** | `llm/stream` | **历史消息 + 模型自己写过的内容 + tool-call 参数 + system**：深拷贝整份请求、替换命中内容后直接续到适配器边界 |

前两道关口发生在**写入会话日志之前**，所以替换结果持久生效。但"已经躺在日志里"的内容（本次会话早先读进来的、
模型自己写出来的、tool-call 参数）前两道关口碰不到——请求是从日志派生的，它们照样出网。第三道关口补上这个洞：

```text
llm/stream(options, next)
  ├─ 命中规则 → scrubRequest(options) 深拷贝清洗
  │            → llm.adapterStream(clean, undefined)   // 直接续链，不重进瀑布
  └─ 未命中   → next()                                  // 原样放行
```

不重进瀑布是有意的：其它 `llm/stream` 监听器（会话标题观察、检查点 flush）不会被同一次调用重复触发。
若 `adapterStream` 不存在则退回公开的 `llm.stream(clean)`，并用 WeakSet 防止递归。

### 400 自动恢复（`recoverOn400`）

万一还是 400（例如内容里有你**还没写进屏蔽表**的字符），插件在 `agent/request-error` 里接管：

1. 判定 `failure.status === 400`（或 `code === 'INVALID_REQUEST'`，DeepSeek 适配器就是这么映射的）；
2. 开启**加硬清洗**：在规则之外额外剥离 emoji / 旗帜 / 杂项符号一类码位（`[\u{1F000}-\u{1FAFF}]` 等），持续 `aggressiveMs`；
3. 返回 `{ kind:'retry' }` —— 循环重试时会**重新从会话日志派生请求**，于是这一次就能发出去，**对话与上下文保持连续，不用新建会话**。

窗口内重试次数由 `maxRecoveries` 封顶（默认 2 次 / 10 分钟），避免 400 循环；到顶后照常失败并提示"把触发内容加进屏蔽表"。

> 加硬清洗也可以在没出事时常开：`aggressive: true`（偏执模式）。

### 路由（provider/model）怎么来的

`agent/pre-step` / `tools/post-execute` 的载荷里没有 provider/model，而规则是分 Provider ID / 模型的。
插件监听 `agent/request` 瀑布，按 agent 记住最近一次解析出的 `provider`/`model`，供清洗时套用专属规则；
会话退场（`agent/disposed`）时清掉缓存。

**边界**：会话第一次请求之前路由还没解析出来，此时只套 `global` 规则；第一次请求之后，该会话的专属规则就都能用上。
出网前那一道直接用请求自带（且最准）的 `options.provider` / `options.model`，不受这个限制。

---

## 能力与边界（务必读）

**会被替换的**（命中屏蔽表即换，三道关口合计覆盖）：

- 用户/插件发来的**新**消息（`agent/pre-step`，进日志前）；
- 所有**工具结果**文本（`tools/post-execute`，进日志前）；
- **出网前的整份请求**（`llm/stream` 深拷贝清洗）：历史消息、模型自己写过的 text/reasoning、`tool-call` 参数、system —— 包括**装插件之前就已经躺在日志里**的内容。

**仍然不会替换的**：

- `tool-call` 参数里的替换是**文本级**的：它保持 JSON 合法，但如果某个规则正好匹配到 JSON 结构字符（比如规则里写了 `"command"`），替换后语义仍合法、只是工具可能收到不同参数 —— 规则尽量写"内容词"，别写结构词；
- 图片/文件附件（二进制，不参与文本替换）；
- 命中内容如果**不在**屏蔽表里，就不会被替换 —— 这是 400 的来源。此时 `recoverOn400` 会兜底（加硬清洗 + 重试），但它只剥离 emoji/符号一类码位；治本还是把词加进屏蔽表。

诊断：`sensitive_replace_status` 工具（只读）给出规则数、各关口清洗次数、最近一次出网前替换处数、是否处于加硬清洗、400 自动恢复次数。

---

## 形态

不是插件内置默认目标，而是**用户维护一份 YAML 屏蔽表**，按「全局 / Provider ID / 模型」分类，手动填入需要屏蔽的字符或短语（字形、`\u{XXXX}` 码位、正则均可）。

- 默认文档：`$DSH_HOME/sensitive-blocklist.yaml`（可用 config `blocklistPath` 覆盖）
- 结构：
  - `global:` —— 对所有 Provider ID 生效的字符列表（最通用）
  - `providers:` 下按 Provider ID 分键 —— 键 = **DSH 的 provider 路由 id**（即请求 `options.provider`，如 `deepseek-official`）
- **保存即生效**：按文件 mtime 热重载，增删屏蔽项无需重启

```yaml
# 敏感字符屏蔽表（支持注释）
global:
  - '\u{1F600}'             # 对任何 Provider ID 生效（emoji 码位举例）
providers:
  deepseek-official: []     # 仅对 DeepSeek 官方生效（Provider ID 精确匹配）
```

### 匹配模式（按 Provider ID / 模型，三级链）

`providers.<键>` 的键对应当前请求的 `options.provider` —— 这是 **DSH 的 provider 路由 id**（设置页 / `settings.yaml` 里每个 provider 配置的 id），**不是显示名、也不是厂商名**。
按「来源名」猜键名（`deepseek` 对不上真实 id `deepseek-official`）会导致专属规则**静默空转**。

三级匹配链（从宽到窄，同时生效叠加）：

1. `global` —— 对任何 Provider ID 生效；
2. `providers.<id>` —— Provider ID 匹配：精确键优先，键尾带 `*` 为前缀模式（一族 id 共用，多命中取最长前缀）；值可为数组（简单）或对象 `{ '_': 基础, models: 按模型 }`；
3. `providers.<id>.models.<model>` —— 再按模型细分（`options.model`），模型键精确优先，键尾 `*` 为前缀模式。

```yaml
providers:
  deepseek-official:
    _:
      - '示例词A'                    # 该 Provider 所有模型的基础规则（对象形态的基础规则放 `_`）
    models:
      'deepseek-flash': [ ... ]      # 精确键：本机真实 model id，只对该模型生效
      'deepseek-*': [ ... ]          # 前缀模式：一族模型共用（多命中取最长前缀）
  'deepseek*': [ ... ]               # 前缀模式：一族 Provider 共用（此处为举例）
```

> ⚠ **这页最容易写错的三种写法**（都真实踩过，注意对照）：
>
> 1. **数组形态里再缩进写 `models:`** —— YAML 直接报错 `bad indentation`（序列里不能放映射键）。只有基础规则时用数组 `deepseek-official: [ '词A' ]`；要按模型细分就必须改成对象形态、基础规则放 `_` 下（如上例）。
> 2. **`models:` 与 `deepseek-official:` 同级** —— 会被解析成**另一个 provider**（id 就叫 `models`），里面的条目**静默失效**：不报错、不警告、永不命中。
> 3. **模型键写成显示名/厂商名/猜的版本号** —— 必须写本机真实的 `options.model`（如 `deepseek-flash`）；用 `deepseek-v4-flash`、`deepseek-ai/*` 这类猜的键会静默不匹配。
>
> 另外记住：**精确键命中后不再回落到前缀键**（设计行为）。所以同一个 model 上，`models` 里写了精确键时，同族的前缀键不会再生效——想验证前缀键，换一个没有精确键的 model 试。

### 条目写法

- 普通字符串 = 字面量（精确匹配，`\u{XXXX}` 码位会自动解码）；
- `re:...` = 正则表达式（`u` 标志、大小写敏感；无效正则**跳过并记警告**，不中断其它规则）
  ```yaml
  global:
    - 're:机密[0-9]{2,}'
  ```
- 占位符支持 `{n}` 模板：`replaceWith: '[BLOCKED:{n}]'` ⇒ 每次命中替换为**带规则序号**的占位符（1 起：`global` 在前、当前 Provider/模型规则在后），
  配合工具返回的 `hits` 明细（`n` × `count`），按屏蔽表当前文件对应条目即可**还原原文**；不写 `{n}` 时保持单一 `[BLOCKED]`（默认，向后兼容）。

> 值写法：单引号 `'...'`（内容原样）或裸写；**不要用双引号包 `\u{XXXX}`**（YAML 会把它当转义解析而报错 —— 若文件写坏，插件自动面空转并在日志/工具结果提示「YAML 解析失败」，不影响其它功能）。

---

## 工具面

- `replace_sensitive` —— 手动清洗任意文本；`provider` / `model` 缺省只套全局规则，指定时叠加对应专属规则；返回清洗后文本、替换计数与命中明细（`hits`）。
- `sensitive_replace_status` —— 只读诊断：规则数、各关口清洗次数、最近一次出网前替换处数、是否处于加硬清洗、400 自动恢复次数。**不返回任何屏蔽词内容**，可安全用于确认"出网前清洗是否真的在工作"。

---

## 配置（profile `cordis.patch.yml` 里按行 id 覆盖）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | boolean | true | 总开关（工具面 + 自动面） |
| autoReplace | boolean | true | 进上下文前自动替换（`agent/pre-step` + `tools/post-execute`） |
| dispatchScrub | boolean | true | **出网前清洗整份请求**（深拷贝后替换，含历史 / 模型输出 / tool-call 参数 / system） |
| detectUnfiltered | boolean | true | 未开启 `dispatchScrub` 时的只读扫描：仍有命中就记警告 |
| recoverOn400 | boolean | true | 400 时开启加硬清洗并 `retry`（对话保持连续） |
| aggressiveMs | number | 600000 | 加硬清洗持续时长（ms） |
| aggressive | boolean | false | 常开加硬清洗（不等 400 也额外剥离 emoji / 符号） |
| maxRecoveries | number | 2 | 10 分钟窗口内最多自动重试几次（防 400 循环） |
| blocklistPath | string | `$DSH_HOME/sensitive-blocklist.yaml` | 屏蔽表文档路径 |
| replaceWith | string | `[BLOCKED]` | 替换占位符——含 `{n}` 时按规则序号编号（便于还原），明示内容被屏蔽而非静默删除 |

`replaceWith` 用进 `tool-call` 参数时会自动做 JSON 转义，不会把参数弄成非法 JSON。

---

## 测试用例

安装/构建后所有断言都可直接跑，判断链路真通（不是只看退出码）。

### 自动单测（在包目录执行）

```bash
npm install          # 装运行依赖 js-yaml 与 peer（cordis / schemastery / dsh-tools / dsh-llm）
npm test             # 等价于裸 `node --test`
```

裸 `node --test`（自动发现 `tests/` 下的用例；**别用** `node --test tests/` 或 `node --test tests`——Node 会把目录当模块入口，直接报 `MODULE_NOT_FOUND`；也别用 `node --test test/*.test.mjs` 这类通配写法——不通配展开的 shell 会跑 0 个用例假绿）。四个文件：

> 仓库内所有用例的 provider / model 键与规则条目都是**编造的占位符**，不含真实屏蔽词。

- `tests/match.test.mjs`（8 条）：三级匹配链——`global` 兜底、Provider ID 精确键、键尾 `*` 前缀模式（多命中取最长）、未命中时只套全局、显式空键阻止回落。
- `tests/features-v040.test.mjs`（8 条）：模型精确 / 模型前缀 / 未命中只基础、显式空模型键防回落、Provider 前缀族内按模型、正则命中 + 无效正则记警告、`{n}` 编号占位符 + `hits` 明细、默认无 `hits`、`global` 在前、旧数组形态等价。
- `tests/auto-v041.test.mjs`（14 条）：用假 ctx 捕获真实注册的监听器来驱动 —— `agent/pre-step` 替换且**保留消息 id / 不原地改写**、无命中与 `reject` 原样透传、空表不介入；`tools/post-execute` 替换 content 与 `tool-result` 嵌套块、value / block 形态不动；路由追踪（`agent/request` 之后套用专属规则、`agent/disposed` 后回到只 global）；开关组合、坏屏蔽表不抛；以及**根因回归**（对 `dsh-llm` 工厂产出的真实深冻结消息同样能清洗）。
- `tests/outbound-v050.test.mjs`（8 条）：`scrubRequest` 覆盖 text/reasoning/tool-result/tool-call 参数/system 且不动原请求、保留消息 id；tool-call 参数的 JSON 安全性（占位符含引号也不破 JSON）；`llm/stream` 命中时**不调用 next、直接续到 `adapterStream`**、无命中时放行、`dispatchScrub=false` 退回只读扫描；`agent/request-error` 的 400→retry、非 400 放行、超上限放弃；400 之后**规则外的 emoji 也被加硬清洗剥离**。

期望结果：**tests 38 / pass 38 / fail 0**（EXIT=0）。

### 30 秒手测（链路是否真通）

示例屏蔽表（`samples/sensitive-blocklist.example.yaml`）在 `global` 里放了一个**随机低碰撞占位符** `blocklist-check-9f3a8c21e7`（不含任何真实敏感词）。把它复制为 `$DSH_HOME/sensitive-blocklist.yaml` 后：

1. **工具面**：调工具 `replace_sensitive`，`text` 含 `blocklist-check-9f3a8c21e7`，`provider` 不填；
   期望返回 `removed=1`、`cleaned` 里出现 `[BLOCKED]`。
2. **进上下文关口**：让 agent 跑一条命令 `echo blocklist-check-9f3a8c21e7`；
   期望**你看到的工具结果里就是 `[BLOCKED]`**（说明结果在写入日志前已被替换），日志同时出现
   `工具结果进入上下文前替换 1 处命中字符`。
3. 再直接给 agent 发一句含该占位符的话；模型看到的内容里该串应已被换成 `[BLOCKED]`。
4. **出网前关口**：把该串放进 agent 的**命令行参数**里（tool-call 参数不会被关口 1/2 洗，会原样留在日志），
   然后调 `sensitive_replace_status`：`dispatchScrubs` / `dispatchLast` 应该 > 0 —— 证明请求在出网前被拷贝清洗过。
5. 验证完删掉该占位符，换成你自己的屏蔽词。

---

## 安全约定

源码 / 日志 / 输出不携带屏蔽字符字形，只以码位、计数与规则序号出现；替换位为纯 ASCII 占位符（默认 `[BLOCKED]`），明示内容被屏蔽而非静默删除。**本仓库任何文件（含 `tests/`、`samples/`、README 与类型注释里的示例）都不含真实屏蔽词** —— 示例一律用随机低碰撞占位符（`blocklist-check-…`）或编造的 provider / model 键；真实屏蔽表只存在于使用者本机 `$DSH_HOME/sensitive-blocklist.yaml`，发布包可放心分发。

> 也就是说：**出网前那道清洗不写日志、也不回填日志** —— 日志里保留原文，只有发往 provider 的那一份被替换。
> 这是有意的：不改写会话日志的"可重建"语义，人类看到的对话记录也保持完整。

---

## 版本变更

### 0.6.2

- **仅打包与文档，无行为变化**：仓库公开前的清理 —— 测试与文档示例里的真实屏蔽表内容
  与本机标识（provider / model 键、码位示例）一律换成编造的占位符；修好 `npm test`；
  去掉指向不存在的 `tsconfig.json` 的 `build` / `typecheck` 脚本与无用的 TS devDependencies；
  补齐 LICENSE / .gitignore / 包元数据（repository / keywords / engines 等）。

### 0.6.1

- **对齐 DSH 0.2.0-rc.x，去掉跨版本豁免**：`peerDependencies` 里 `dsh-tools` / `dsh-llm`
  放宽为 `^0.1.0-rc.6 || ^0.2.0-rc.1`（DSH 校验时带 `includePrerelease`，因此覆盖
  0.1.5-rc.x / 0.2.0-rc.x / 0.2.0 / 0.2.1-alpha.x / 0.2.1），不再需要
  `dsh plugin allow-version` 的精确版本豁免。
- **适配器边界改为显式 `continueToAdapter()`**：rc2 起 `llm.adapterStream` 被标为 private
  （运行时仍在），公开入口只剩会重进瀑布的 `llm.stream()`；现在优先直连边界，缺失时退回
  `llm.stream()` 并**只告警一次**。
- **新增 `scrubDurableRequests`（默认 true）**：rc2 的 log-reconstruction 不变量声明带
  `sessionId` 的请求"只读不改写"；设为 `false` 即严格守约（只留进上下文清洗 + 只读告警）。
- `sensitive_replace_status` 增加 `version` / `scrubDurableRequests`，重启后一次工具调用
  即可确认运行时加载的是哪一份构建。

### 0.5.0

- **新增出网前清洗 `dispatchScrub`（默认开）**：在 `llm/stream` 里深拷贝整份请求（历史消息、模型自己写过的
  text/reasoning、`tool-call` 参数、system）替换后直接续到适配器边界。这是唯一能清掉"已经进过日志"的内容的关口；
  v0.4.1 对此只能告警（请求深冻结、原地改写必然失败）。
- **新增 400 自动恢复 `recoverOn400`（默认开）**：捕获 400（`INVALID_REQUEST`）后开启加硬清洗
  （额外剥离 emoji/旗帜/杂项符号码位）并返回 `{kind:'retry'}`；循环重试会重新从日志派生请求，
  于是能发出去、**对话与上下文保持连续**，不需新建会话。窗口内重试次数由 `maxRecoveries` 封顶。
- 新增 `aggressive`（常开加硬清洗）、`aggressiveMs`、`maxRecoveries` 三个配置。
- 新增只读诊断工具 `sensitive_replace_status`。
- `replaceBlocksCopy` / `replaceMessageCopy` 支持 `tool-call` 参数（自动 JSON 转义，不破 JSON）；
  新增导出 `scrubRequest`。
- `detectUnfiltered` 语义收窄为"未开启 `dispatchScrub` 时的只读扫描"。

### 0.4.1

- **修正自动面落点**：由 `llm/stream` 原地改写（在深冻结消息上必然抛错、被 catch 后静默空转）改为
  `agent/pre-step` + `tools/post-execute`，在内容写入会话日志前替换，替换结果持久生效。
- 新增 `detectUnfiltered`（默认开）：出网前只读扫描，命中未替换内容时告警。
- 新增路由追踪（`agent/request`）：进上下文阶段也能套用 Provider ID / 模型专属规则。
- 新增辅助导出：`replaceBlocksCopy` / `replaceMessageCopy` / `countText` / `scanBlocks` / `scanOptions`；
  移除原地改写的 `replaceBlocks` / `replaceMessage` / `sanitizeOptions`（它们在本平台上永远失败）。
- 包改为 **DSH Profile Bundle**（`package.json` 的 `dsh.bundle.patch` + 自带 `cordis.patch.yml`），
  `dsh plugin --profile <p> add` 后自动入层栈，不再需要手写插件行。
- README 去掉平台专属的安装方式与硬编码路径，改为通用写法（`$DSH_HOME` / `%DSH_HOME%`）。
- 修正 `samples/` 与 README 里**会静默失效的 YAML 示例**（数组形态里嵌 `models:`、以及猜的模型键），并补上「三种写法坑」警示 —— 原示例照抄会漏掉模型级规则。

### 0.4.0

- 三级匹配链（global → Provider ID → 模型）、`{n}` 编号占位符与 `hits` 明细、`re:` 正则条目。
