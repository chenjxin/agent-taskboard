# Changelog — agent-task-board

版本清单与功能说明。在线版本:`GET /changelog`。

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
