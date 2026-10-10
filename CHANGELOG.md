# dsh-sensitive-replace — 变更记录

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
