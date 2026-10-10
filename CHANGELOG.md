# dsh-sensitive-replace — 变更记录

## v0.7.0（写错形态不再静默失效 + 规则级命中计数）

1. **屏蔽表「语法合法但语义写错」的形态改为显式告警**。此前只有 YAML 语法错误
   （`parseError`）与无效 `re:` 正则会报，另外几种写错法一律静默失效 ——
   用户以为规则在防抖、实际一条都没生效。现在 `parseBlocklist` 会记录：
   顶层出现 `global` / `providers` 之外的键、`providers.models`（把 `models:`
   写成了与 provider 键同级）、provider 下直接写模型名、`global` / `providers` /
   `models` 类型不对、条目不是字符串（数字/布尔没加引号）、`re:` 正则无效，
   以及兜底的「这个 provider 一条规则都没解析出来」。
   - 加载与**热重载**时逐条写进运行日志（`屏蔽表警告: …`；按
     `mtime|警告数|解析错误` 去重，只在版本变化时打，不刷屏）；
   - `sensitive_replace_status` 新增 `warningList`，`replace_sensitive` 的
     `note` 也带上；
   - 警告只报**位置与形态**（`global 第 N 条` / `providers.<id>.models.<model>`），
     不复制规则或正则文本 —— 警告本身不该成为泄露面。
2. **规则级命中计数**：`sensitive_replace_status` 新增 `ruleHits` —— 每条规则的
   累计命中次数与最近命中距今秒数，`scope` 指明它在文件里的位置。编号规则：
   去重后按出现顺序（先 `global`，再按文件顺序遍历 `providers`：每个 provider
   先 `_` 基础规则、再 `models` 各模型键）。用途：确认「新加的规则到底有没有在
   真实流量里命中」，不必再发测试消息。**仍然不返回任何屏蔽词内容**，只给编号。
3. **API 向后兼容的扩展**：`replaceText` / `replaceBlocksCopy` /
   `replaceMessageCopy` / `scrubRequest` 新增可选 `sink(rule, count)` 回调
   （不传则行为与 0.6.2 完全一致），自动面（`agent/pre-step`、
   `tools/post-execute`、`llm/stream`）用它做上述计数。新增导出 `ruleIndex`。
4. **新增 Linux / macOS 版探测脚本 `content-risk-interactive.sh`**：与
   `content-risk-interactive.ps1` 功能对齐（single / batch / binary 三模式、
   `mode`/`model`/`file`/`h`/`q` 命令），依赖只有 bash 4+ 与 curl（不需要
   jq / python）。相对 PS1 多三处：① 非交互开关 `-t/-T/-f/-s/-n/-b` 与退出码
   （0 未触发 / 2 触发 400 / 3 网络失败 / 4 用法缺参），便于脚本化；
   ② 二分收尾补「长度 n-1 的前缀与后缀」两个决定性探测 + 「删掉中间一个字符」
   机制判定，从而把「最小连续片段（整段缺一不可）」与「上下文组合触发（两个
   分离片段共同作用）」分开报（PS1 会把前者也报成组合触发）；
   ③ 切片对齐 UTF-8 字符边界（locale 非多字节时先尝试用 UTF-8 locale 重跑自己，
   否则用 iconv 校验），避免切出半个汉字/emoji 造成假 400。
   该脚本用假服务端做了 18 项验收（含多字节、无空格长串、组合触发、批量只中间
   一个词命中、网络不可达、缺 key 不挂起等）。
5. **PowerShell 探测脚本 `content-risk-interactive.ps1` 两处修复**（都在真实 PowerShell 5.1 +
   假服务端上复现并验证过）：
   - **二分收尾的误判**：对"整段字符缺一不可"的连续触发片段也会报成「上下文组合触发」。
     现补上「长度 n-1 的前缀/后缀」两个决定性探测与「删掉中间一个字符」的机制判定，
     与 Linux 版报法一致（最小连续片段 / 两个分离片段共同作用）。
   - **请求体带 BOM**：旧版用 `Set-Content -Encoding utf8`（PS 5.1 会写 UTF-8 BOM），
     带 BOM 的 JSON 在严格的后端/网关看来是非法请求体，其 400 会被误当成"命中触发词"——
     假阳性会把二分引向不存在的片段。改为 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`
     写无 BOM 的 UTF-8；读响应也显式按 UTF-8 读。
6. **文档**：补「替换是单向的、插件不提供还原」的明确说明与平台限制依据
   （`PreToolDecision` 无改参、会话事件 append-only）；
   新增《与同类插件的关系》（与 dsh-text-guard 的逐项对比，并说明为什么不需要
   另挂 `tools/ptc-dispatch-log` —— 子分发结果写该日志前已经过
   `tools/post-execute`）；补两个探测脚本的用法说明。
7. **测试**：新增 `tests/v070.test.mjs`（8 条），全量 46 条。

## v0.6.2（仓库公开前的清理；无行为变化）

代码路径与 v0.6.1 完全一致，只动打包与文档：

1. **去掉真实屏蔽表痕迹**：测试与文档示例里的 provider / model 键、码位示例一律换成
   编造的占位符。此前 `tests/` 里以"真实屏蔽表结构"为名的用例照抄了使用者的真实屏蔽表
   结构与条目 —— 而 `package.json` 的 `files` 含 `tests`，等于随包分发，已修正。
   本仓库现在任何文件（tests / samples / README / 类型注释）都不含真实屏蔽词。
2. **修好 `npm test`**：脚本由 `node --test tests/` 改为 `node --test`（Node 22 下
   前者会把目录当模块入口，报 `MODULE_NOT_FOUND`）。
3. **删掉坏脚本**：`build` / `typecheck` 指向并不存在的 `tsconfig.json`，且本包源码
   就是 `lib/index.js`（没有 `src/`）；连同无用的 typescript / @types devDependencies 一并去掉。
4. **补仓库文件**：`LICENSE`（MIT）、`.gitignore`、`package.json` 元数据
   （repository / homepage / bugs / keywords / engines / author）。
5. 文档对齐：README 版本号、安装示例与"版本变更"补齐 0.6.x；CHANGELOG 去掉本机路径。

## v0.6.1（首个部署到 web profile 的 rc2 兼容构建）

背景：0.5.0 在 DSH 0.2.0-rc.2 下 peerDependencies 不满足，只能靠
`dsh plugin allow-version dsh-sensitive-replace@0.5.0 --dsh-version 0.2.0-rc.2` 的
**精确版本豁免**强行加载。豁免等于"包自称的兼容范围与运行时不符"，是待清的债。
0.6.1 把这个债清掉。

### 1. 清单：不再需要豁免
- `peerDependencies`：`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`
  由 `^0.1.0-rc.6` 放宽为 `^0.1.0-rc.6 || ^0.2.0-rc.1`
  （已用 semver 验证：0.1.5-rc.1、0.2.0-rc.1、0.2.0-rc.2、0.2.0 均满足）。
- 结果：0.2.0-rc.2 下 `--dump-config` 0 跳过、0 不兼容告警，
  `compatibility.json` 不再需要任何条目（部署后为 `{}`）。

### 2. 代码：对齐 rc2 的真实契约
1. **适配器边界改为显式 `continueToAdapter()`**：rc2 把 `llm.adapterStream` /
   `streamWithRegistration` 标为 private（运行时仍在），公开入口只剩会重新进入
   `llm/stream` 瀑布的 `llm.stream()`。现在优先直连边界（不重进瀑布，避免其它监听器
   重复观察同一次调用），缺失时退回 `llm.stream()` 并**只告警一次**，不再静默降级。
2. **新增 `scrubDurableRequests`（默认 true）**：rc2 的 `dsh-agent-loop` 增加了
   log-reconstruction 不变量——带 `sessionId` 的请求是"由会话日志纯函数重建"的，
   文档明确 "listeners read it, never rewrite it"。本插件的 `dispatchScrub` 对这类请求
   属于**刻意的应急改写**（让本次出网内容与日志暂时不一致，这正是屏蔽的本意）。
   默认保持 0.5.0 行为；设为 `false` 即严格守约：只留进上下文清洗 + 只读扫描告警。
3. **`sensitive_replace_status` 增加 `version` / `scrubDurableRequests`**：
   重启后一条工具调用即可确认运行时到底加载了哪一份构建（`v0.6.1`）。

### 3. 打包
- 恢复 `samples/sensitive-blocklist.example.yaml`（从 0.5.0 的 tarball 原样取出，
  未在本机读取其内容）。
- 0.6.0 是本地过渡构建（tarball 与 lockfile 完整性不一致，且缺 samples），
  已删除，未部署。

### 4. 验证（与部署副本逐字节一致）
- 探针脚本（独立于本包，不启动 DSH、不读用户屏蔽表，只用无害探针词 ZQPROBEZQ
  走一遍 rc2 的真实挂钩契约）：37/37 通过。
- 包自带单元测试：38/38 通过（裸 `node --test`，输出只取汇总行）。
- `dsh --profile web --dump-config`：退出码 0、1276 行、0 跳过 / 0 不兼容。
- SHA256：`lib/index.js`、`lib/types/index.d.ts`、`package.json` 与探针验证过的
  工作区构建完全一致。

### 5. 已知边界（未改动的行为）
- 路由未知时（本 agent 的首次 `agent/pre-step`，或工具结果早于本会话第一次请求）
  进上下文阶段只套 `global` 规则。若屏蔽表里 `global` 为空，这一步不做替换——
  但请求出网前那道网会用**真实 provider/model** 兜住（探针第 4b 组已断言）。
- 模型自己产出的文本、tool-call 参数、系统提示词装配结果不走进上下文钩子，
  只能靠出网前清洗 / 只读告警覆盖。

### 6. 回滚
```
dsh plugin --profile <profile> add <path>/dsh-sensitive-replace-0.5.0.tgz
dsh plugin --profile <profile> allow-version dsh-sensitive-replace@0.5.0 --dsh-version 0.2.0-rc.2 --accept-risk
```
离线回滚点：升级前把 profile 目录下的 `package.json` / `pnpm-lock.yaml` /
`compatibility.json` 各留一份 `.bak` 副本即可。
