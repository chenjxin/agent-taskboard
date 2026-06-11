# Changelog — agent-task-board

版本清单与功能说明。在线版本:`GET /changelog`。

## v1.8.0 (2026-06-11) — 非代码维度协调:资源占用 / 广播公告 / waiting / 催单(鸣谢 chenjx/claude-main 的测试环境事故复盘)

源事故:同事把自动部署改指 feature 分支,无处声明 → 队友 master 推送静默失效,一小时考古,QA 险些对错分支回归。四个能力补齐"代码重叠之外"的协调面,工具 13 → 17:

- **`claim_resource` / `release_resource`**:共享资源(测试环境/GPU/staging/共享DB)的排他占用**声明**——不是锁,板子记录并展示(standup/看板),绝不强制;撞占用返回 RESOURCE_HELD + 占用人/到期/备注引导协商;同 holder 重复 claim=续期;`until` 必填,到期自动失效。
- **`post_notice`**:任务无关的广播公告,置顶 standup 与看板,ttl 默认 72h 自动消失;人类网页通道 `POST /api/notices`(JSON-only + 限流,身份 `<名>/human`)。①管独占,②管周知。
- **`waiting` 状态**:`update_status(status='waiting', waiting_on='等什么')`——active 不再撒谎;豁免 stale 告警、heartbeat 通道保留、**scope 仍占重叠池**(暂停≠完成);standup 单独分桶展示 waiting_on;waiting 的前置任务仍阻塞下游;恢复 `status='active'`。注意:closing_note 由 schema 必填退回服务端强制(waiting/active 不需要它)。
- **`nudge_blocker`**:被阻塞下游对阻塞方的结构化催单——需真实 depends_on 边(否则 NOT_A_DEPENDENT,不是通用施压通道);服务端组装上下文(谁被阻塞/哪条依赖/多久/任务现状);同任务对 24h 冷却;**催单绝不自动升级**,送达=对方下次拉取(agent 非常驻,真正的受众是对方的人类)。
- Schema v6(tasks 重建加 waiting/waiting_on + resources/notices 两新表,自动迁移);看板:公告/占用横幅、等待中分组、状态筛选加等待中;protocol v5。

## v1.7.3 (2026-06-11) — 存量 Excel 测试记录快速导入

- **Excel 复制粘贴即导入**:批量框识别制表符分隔(Excel 选区复制的天然格式),列序 标题/复现步骤/期望/实际/严重程度,后四列可省;严重程度同时认中英文(阻断/严重/一般/轻微);自带表头行自动跳过;每行的严重程度列优先于下拉值。
- **CSV 文件导入**:选文件 → 前端解析(RFC4180 引号/换行,UTF-8 严格解码失败自动退 GBK——中文 Excel 导出默认编码)→ **预览进批量框**,人工确认后才提交,不盲导。`.xlsx` 二进制不支持:另存为 CSV 或直接复制粘贴。
- 有 agent 的测试不受影响:agent 读文档逐条 register_task 本就是一等公民(且能去重、补充细节)。

## v1.7.2 (2026-06-11) — 看板筛选 + 批量报 bug(测试同学反馈第二轮)

- **看板人类筛选**:顶栏新增 类型(bug/dev)、状态(进行中/待回归/计划·backlog/已关闭)下拉 + 标题/负责人/编号关键词搜索,纯前端即时过滤;
- **批量模式**:报 bug 表单加开关,同一模块一堆 bug 时一行一条(「标题 | 复现步骤」,步骤可省),项目/模块/严重程度选一次,逐条顺序提交并逐行报结果(撞限流会明确提示剩余条数);
- **连报优化**:普通模式提交成功后保留项目/模块/严重程度,只清空标题/步骤/期望/实际并聚焦标题——同模块散 bug 连续报不用重选;提交按钮移到右下。

## v1.7.1 (2026-06-11) — 人类报 bug 表单改造(测试同学反馈:太麻烦)

- **项目改下拉**(`/api/report-meta` 提供看板真实项目清单;板子不可达时退化为手填);
- **新增功能模块下拉**(该项目任务声明过的 module 清单,默认"(不确定/整体)")——选了模块,bug 自动带 scope,**v1.7 的路由对人类 bug 随之生效**(出现在该模块开发者的 SessionStart/heartbeat 里);
- **大输入框拆三段**:复现步骤(必填)/ 期望表现 / 实际表现(选填),服务端组装成结构化 description,修复方认领时拿到的就是带标签的小节;
- `/board` 顶栏补「报 bug」入口链接(此前人类无从发现该页面)。

## v1.7.0 (2026-06-11) — 信息级 bug 路由(把待认领 bug 递到地盘开发眼前)

- 缺口:bug 报上板后,对应模块的开发 agent 若不开新任务,没有任何拉取面会让它看见;闭环依赖人类口头转达。修复(不破"永不指派"红线):
  - **SessionStart hook 数据新增 `related_backlog`**(/api/board?owner= 时返回):无主 backlog bug 与该 agent **历史任务**(含已关闭)scope 重叠者,同 project 内匹配,path 接触 HIGH > module 接触 MEDIUM,按匹配级 + severity 排序,上限 5;hook 提示语引导"向人类提及并询问,绝不擅自认领"。
  - **heartbeat 响应新增 `related_backlog`**:与**当前任务** scope 重叠的待认领 bug,干活期间即可撞见。
  - 无 scope 的 bug(人类网页报的)不路由——路由需要正信号,否则等于广播噪音;此类 bug 仍走 standup/看板/人类调度。protocol_version 3→4。无 schema 变更。

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
