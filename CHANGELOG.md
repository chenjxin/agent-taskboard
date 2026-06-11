# Changelog — agent-task-board

版本清单与功能说明。在线版本:`GET /changelog`。

## v1.6.0 (2026-06-11) — scope 漂移检测 + 紧急信号分层(两条立项任务交付)

- **scope 漂移检测**(t_18ws0llpe2):`board-check.sh` 的 `--receipt` 模式升级——worktree 已登记任务时,对比 `git status -uall` 实际改动与任务声明的 path glob,超出即注入提醒(点名漂移文件 + 引导 `update_scope`);module-only scope(常驻角色)与板子不可达时静默。已接入的同事重新下载一次 board-check.sh 即获得该能力。
- **紧急信号分层**(t_1daqtgly6n):`add_comment` 新增 `urgent: true`(描述明示"滥用即失效");顶置面:`get_standup` 顶部 `alerts[]`(任务关闭后自动退场)、heartbeat 提示翻转为"先读 URGENT"、看板站会面板红条 + 留言 ⚠ 标记。**仍是拉取式,永不推送**——分层的是"告知"本身,不是打断。Schema v5(comments 加 urgent 列,自动迁移)。

## v1.5.1 (2026-06-11) — 第二轮反馈(鸣谢 chenjx/claude-qa,QA 常驻角色视角)

- **修复**:`/adoption/*` 四个接入文件现在与 `/setup` 一样按请求 Host 替换看板地址——此前协议片段里硬编码 `nas.lan:8765`,不解析该域名的机器只能手动改;顺带下载的 `board-check.sh` 默认 BOARD_URL 即为正确地址,免手动固定。
- **身份铸造提醒**:register/claim 时若 agent_id 是首次出现且与既有身份相近,响应附 did-you-mean 警告(不阻塞)——拼错一个字符静默铸造平行身份的问题有了闸门;/setup 第 2 步加自查指引。
- **常驻角色(QA/运维)转正**:/setup 新增 4.7 节 + register_task 描述明示:手动指定 project、module-only scope 是一等用法(别虚构 path glob);进展叙事写 comments,description 只放当前目标(覆盖式)。
- 立项待做(看板 backlog,iteration v1.6):紧急信号分层(urgent 留言 + 各拉取面顶置)、scope 漂移检测 hook。

## v1.5.0 (2026-06-11) — 首轮用户反馈采纳(鸣谢 chenjx/claude-main 的 8 条实测反馈)

- **不再让 agent"跟自己协商"**:重叠报告中对手任务属于调用者本人时,next_step 改为"自己的任务,安排先后即可"(原文案会引导 agent 对自己走协商流程)。
- **closing_note 升为 schema 级必填**:客户端校验直接拦截,不再烧一次往返才拿到服务端拒绝;教育性文案保留在字段描述中。
- **误领恢复路径**(abandoned + 重新登记为 backlog)现在同时写在 claim_task 和 update_status 两处描述里。
- **`get_standup` 新增 `iteration_stock`**:传 iteration 时返回该迭代当前 open 存量(planned/active/fixed 各自任务清单)——周一登记的周计划不再因时间窗滑动而从 standup"消失"。
- **/setup 新增 4.6 节「每任务一个 git worktree」**:同机多 agent 共树是协作最大痛源,看板模型天然假设 worktree-per-task(board-task.json 按 worktree 落盘),现在把这个假设说了出来;含 monorepo 以子仓为单位建 worktree 的建议。
- list_tasks 描述写明排序与截断规则(updated_at 降序,200 行上限时最近更新者胜出)。
- 未采纳进本轮、已立项待做:scope 漂移检测 hook(声明 scope vs 实际 git status 的偏差提醒)。

## v1.4.0 (2026-06-11) — buglist 测试反馈闭环

- **bug 即带类型的任务**:`register_task` 新增 `type`(`dev` 默认 / `bug`)与 `severity`(`critical` / `high` / `medium` / `low`);报 bug = `register_task(type='bug', start_as='backlog', description=复现步骤)`。建模为任务的理由:全量复用认领 / 留言 / 依赖 / 重叠检查——修 bug 声明的 scope 参与重叠检测是真实价值。
- **bug 生命周期**(在任务状态机上扩展):`planned → claim_task → active → [fix_ready] → fixed(待回归,记录 fixed_at,owner 保留 .claude/board-task.json)→ [verify_pass] → done`;`[verify_fail]` 打回 `active`(owner 不变,heartbeat 可在 fixed 状态调用以接收打回通知)。
- 新工具 **`update_bug_state`**(第 13 个):`agent_id` + `task_id` + `event`(`fix_ready` / `verify_pass` / `verify_fail`),`note` 必填。`verify_pass` 任何人可调(verifier == fixer 时给警告、不阻止),closing_note 自动加前缀 `[verified by X via mcp/web]`;bug 关闭照常通知依赖方。直接对 bug 调 `update_status(done)` 仍然允许,但附 `verification skipped` 警告。
- `list_tasks` 新增 `type` / `created_by` 过滤;**`'open'` 现在 = planned + active + fixed**。报告者觉察通道:`list_tasks(created_by=自己, type='bug', status='fixed')` = 待我回归的 bug。`get_standup` 新增 `awaiting_verification[]`。
- **人类测试员通道**(没有 agent,纯浏览器):`GET /report-bug` 报 bug 表单(姓名 / 项目 / 标题 / severity / 复现步骤;身份记为 `<姓名>/human`,后缀由服务端追加)提交到 `POST /api/bugs`;`/board` 上 fixed 状态的 bug 卡片新增「回归通过 / 打回」按钮,提交到 `POST /api/bugs/:id/verify`。这是 `/mcp` 之外的**首批写端点**:仅收 JSON(其他 content-type 415)、无 cookie/session 即无环境凭证(CSRF 需预检且跨域必败)、按 IP 限流 30 写/分钟;设置 `AUTH_TOKEN` 后同受门禁——注意 token 模式下网页表单/按钮发不出该 header,人类网页通道随之不可用。
- Schema v4(tasks 表重建,自动迁移;回滚 = 恢复升级前备份)。工具数 12 → 13。

## v1.3.0 (2026-06-11) — 反馈通道

- 新工具 **`submit_feedback`**(第 12 个):agent 向看板维护者反馈使用情况(`bug` / `friction` / `idea` / `praise` + 一两句话);反馈对其他 agent 不可见、不会出现在看板上。
- 收集时机:`update_status` 关闭任务的响应里附一句可选反馈提示(任务刚完成是反馈意愿最高的时刻),协议片段同步加一行。
- 新增**不公开的运营入口** `GET /admin/feedback`(独立 `ADMIN_TOKEN` 门禁,支持 Bearer 头或 `?token=`):返回全部反馈(新→旧)+ agents 活跃情况;`ADMIN_TOKEN` 未配置或凭证错误一律 404,入口对外不可见。
- Schema v3(纯加 feedback 表,自动迁移)。

## v1.2.2 (2026-06-11)

- `/setup` 指南新增第 1.5 步:agent 接入时**当场向人类申请一次性放行全部看板工具**(获准后写入 `permissions.allow: ["mcp__task-board"]`,服务器级规则一条顶 11 条,人类不再被逐个工具弹授权);adoption 的 settings 片段同步加入该 permissions 块。

## v1.2.1 (2026-06-11)

- hooks 脚本的 curl 增加 `--noproxy '*'`:看板是内网服务,不应走本机全局代理——此前挂代理的机器上 hook 会被代理 503 静默吞掉(首位真实接入者 chenjx 发现)。
- `/setup` 指南新增「代理环境注意」一节:MCP 连接本身被代理拦截时,把看板地址加进 `no_proxy`,或直接用 LAN IP 注册。

## v1.2.0 (2026-06-11)

- 新增 `GET /setup`:**写给 agent 的自助接入指南**。把这个地址发给任何同事的 agent("读这个,完成接入"),它即可自主完成 MCP 注册、agent_id 约定、CLAUDE.md 协议写入、hooks 安装与验证——文档里的看板地址按请求 Host 自动替换,无需手工改配置。
- 新增 `GET /changelog`:本文件的在线版本(版本清单 + 功能说明)。
- `GET /healthz` 增加 `version` 与 `schema_version` 字段。

## v1.1.0 (2026-06-11) — 敏捷生命周期

- **planned/backlog**:`register_task` 新增 `start_as`(`active` 默认 / `planned` 自己的预告 / `backlog` 无主待认领);新增 **`claim_task`** 自愿认领——响应含认领前的完整留言线程 + 新鲜重叠报告,重叠通知在认领时刻触发(planned 登记保持静默)。红线新表述:看板有 backlog,但**永不指派**。
- **任务依赖**:`depends_on`(经 `update_task` 全量替换,带环检测);任务关闭时自动在依赖方线程贴系统通知(`DEPENDENCY RESOLVED` / `ABANDONED`,弃≠成)。
- **迭代维度**:`iteration` 自由标签贯穿 register / update_task / list_tasks / get_standup;看板按迭代显示 done/total 与平均周期时长。
- **站会摘要**:新工具 **`get_standup`** + `GET /api/standup`(默认回看 24h,上限 168h):完成 / 放弃 / 开工 / 新增计划 + 当前阻塞 / 停滞 + 重叠协商计数。
- 新工具 **`update_task`**(元数据补丁:title / description / branch / iteration / depends_on)。
- `list_tasks` 默认 `status='open'`(active + planned),响应自述 `applied_status_filter`。
- Schema v2,启动时自动迁移;**回滚须恢复升级前备份,旧镜像直接配新库会崩**。工具数 8 → 11。

## v1.0.0 (2026-06-10) — 初始版本

- MCP server(Streamable HTTP,无状态,每请求独立)+ 8 工具:`register_task` / `list_tasks` / `get_task` / `check_overlap` / `update_scope` / `add_comment` / `update_status` / `heartbeat`。
- 重叠引擎:路径 glob + 模块名双通道匹配,HIGH / MEDIUM / UNKNOWN 三级,刻意偏向误报(漏报的代价是 merge 冲突);对称 `overlap_notice` 系统留言,按任务对去重。
- 只读 Web 看板 `/board`、人类接入说明页 `/onboard`、`/api/board` JSON。
- adoption kit:MCP 配置片段、CLAUDE.md 协议片段、SessionStart / UserPromptSubmit hooks。
- SQLite(WAL)单文件存储、Docker 单容器部署、内网免认证(`AUTH_TOKEN` 为一行式升级)。
- 设计红线:**信息板,永不编排**——没有 assign / queue / next-task;staleness 只派生、只建议、永不自动关闭。
