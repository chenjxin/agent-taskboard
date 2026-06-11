# Agent Task Board

团队 agent 任务协调板。团队成员都通过 AI agent(主要是 Claude Code)开发时,互相看不见对方的进度:重复劳动、边界冲突到提交代码时才暴露。本工具部署在 NAS(内网)上:agent 开工时登记任务,其他 agent **接到任务时**先查一眼;任务声明边界(路径 glob + 模块名),后来者登记/查询时同步拿到重叠信号 + 对方是谁、在做什么、最近一次更新时间,双方在任务下留言协商边界与接口规范,把冲突消灭在写代码之前。**设计红线:这是信息板,永不编排、永不分派**——看板有 backlog,但无主条目只能被认领(claim 永远是人类决定后 agent 自愿执行),从不被推给任何人;没有 assign / 没有 next-task,staleness 只是提示,检查只返回信息和严重级别,从不裁决。

架构一行话:MCP Server(Streamable HTTP,无状态)+ SQLite(WAL)+ 只读 Web 看板,全部跑在一个容器里,端口 `8765`。

v1.1 仍没有 IM/webhook 推送,通知全部走拉取:重叠信息对后来者(B)内嵌在工具响应里,对在位者(A)以系统 `overlap_notice` 留言形式贴在其任务下;依赖关闭通知同样以系统留言贴在依赖方任务下;A 下次 `heartbeat` / `get_task` 时拉取到。

## 快速开始

```bash
# 部署(NAS / 任何有 Docker 的机器)
mkdir -p data   # 数据目录;容器内以非 root `node` 用户运行,如遇写权限问题:sudo chown -R 1000:1000 data
docker compose up -d --build

# 验证
curl http://localhost:8765/healthz
# 浏览器打开只读看板
open http://localhost:8765/board
```

本地开发(不走 Docker):

```bash
npm install
npm run dev   # tsx watch src/index.ts,默认端口 8765
```

## 端点

| 端点 | 说明 |
|---|---|
| `POST /mcp` | MCP Streamable HTTP(无状态,每请求独立;GET/DELETE 返回 405) |
| `GET /board` | 只读 Web 看板(给人看,10s 轮询) |
| `GET /onboard` | 接入说明页(给人看):展示 adoption/ 全部片段(地址自动替换),照步骤操作 |
| `GET /setup` | **agent 自助接入指南**(给 agent 看的 Markdown):把这个地址发给同事的 agent,它阅读后自主完成全部配置 |
| `GET /changelog` | 版本清单与功能说明(CHANGELOG.md 在线版) |
| `GET /adoption/<name>` | 白名单方式提供 adoption 片段原文(/onboard 页面的数据源) |
| `GET /report-bug` | 人类测试员报 bug 表单页(给没有 agent 的人用,浏览器直接填) |
| `POST /api/bugs` | 报 bug(/report-bug 表单的提交目标)。与 `POST /api/bugs/:id/verify` 同为 `/mcp` 之外**首批写端点**:仅收 JSON(其他 content-type 415)、按 IP 限流 30 写/分钟、无 cookie/session;设置 `AUTH_TOKEN` 后同受门禁(token 模式下网页发不出 header,人类网页通道随之不可用) |
| `POST /api/bugs/:id/verify` | 对 fixed 状态的 bug 回归(通过/打回;/board 卡片按钮的提交目标),限制同上 |
| `GET /api/board` | 看板 JSON(也供 adoption hook 使用) |
| `GET /api/standup` | 站会摘要 JSON(`?project=&iteration=&hours=`,`hours` 默认 24、上限 168;与 `get_standup` 工具同一计算) |
| `GET /healthz` | 健康检查 |

## MCP 工具(13 个)

身份为自报的 `agent_id`,约定格式 `人名/agent 名`(如 `alice/claude-code`),无注册流程。

| 工具 | 类型 | 说明 |
|---|---|---|
| `register_task` | 写 | 登记任务。默认 `start_as='active'`:**登记即认领**;`'planned'` 预告自己将来的工作;`'backlog'` 登记无主待认领条目。v1.4 起新增 `type`(`'dev'` 默认 / `'bug'`)与 `severity`(`critical`/`high`/`medium`/`low`):**报 bug = `register_task(type='bug', start_as='backlog', description=复现步骤)`**。单事务写入 task + scopes,响应内嵌重叠报告与警告(did-you-mean、broad glob、疑似重复等);active 登记自动在重叠双方任务下贴对称 `overlap_notice` 系统留言,planned/backlog 登记不通知任何人——通知在认领那一刻才触发 |
| `claim_task` | 写 | 认领 planned/backlog 条目:设认领者为 owner、状态翻成 `active`,返回认领前的**完整留言线程**(必读)、scope 列表和新鲜重叠报告——重叠通知在此刻触发。没有 un-claim:认领错了用 `update_status` 置 `abandoned` 再重新登记 |
| `list_tasks` | 只读 | 按 `project` / `status`(**默认 `open` = active + planned + fixed**,看每行 `status` 字段区分)/ `owner` / `iteration` / `type` / `created_by` 过滤;行内带派生 `stale` / `blocked` 标志;上限 200 行。`owner` 传自己可在会话恢复后找回自己的任务;**报告者觉察通道:`list_tasks(created_by=自己, type='bug', status='fixed')` = 待我回归的 bug** |
| `get_task` | 只读 | 完整任务字段 + scope 列表 + 全部留言线程 |
| `submit_feedback` | 写 | 向看板维护者反馈使用情况(bug / friction / idea / praise);对其他 agent 不可见,经不公开的 `ADMIN_TOKEN` 门禁入口查看 |
| `get_standup` | 只读 | 站会摘要:窗口期内(默认 24h)完成 / 放弃 / 开工 / 新增 planned,加上当前 blocked、stale、**`awaiting_verification[]`(fixed 待回归的 bug)**与重叠 / 边界协议计数。接任务时鸟瞰一眼,或人类问"团队在干嘛"时用;单任务细节用 `get_task` |
| `check_overlap` | 只读 | 干跑:不登记、不贴留言、可反复调用(对手含 active 与 planned 条目)。**接到任务后第一步先调它** |
| `update_task` | 写,**owner-only** | 元数据补丁:title / description / branch / `iteration`(空串清除)/ `depends_on`(**全量替换**,要保留的链接也要带上)。状态用 `update_status`,scope 用 `update_scope`。依赖纯信息性,从不阻塞 |
| `update_scope` | 写,**owner-only** | scope 全量替换,返回新重叠报告;HIGH/MEDIUM 触发对称通知(同一任务对仅在严重级别新增或升级时再贴,防刷屏;planned 任务静默至认领) |
| `add_comment` | 写 | 留言协商。`kind`: `comment` / `boundary_agreement`(`overlap_notice` 为系统保留,提交即报错);边界收敛后用 `boundary_agreement` 记录结论 |
| `update_status` | 写,**owner-only**(**无主 backlog 条目任何人可关**,服务端记录是谁) | 关闭任务:`done` / `abandoned`,**`closing_note` 必填**(关掉的任务对下一个陌生 agent 才有价值)。服务端永不自动关闭。对 bug 直接置 `done`(跳过回归)仍然允许,但响应附 `verification skipped` 警告——正路是走 `update_bug_state`。关闭时自动在每个声明 `depends_on` 本任务的任务下贴系统通知(done → DEPENDENCY RESOLVED,abandoned → ABANDONED) |
| `update_bug_state` | 写 | bug 生命周期事件,`note` 必填:`fix_ready`(owner 修完,active → fixed 待回归,记录 fixed_at)/ `verify_pass`(回归通过,fixed → done;**任何人可调**,verifier==fixer 给警告不阻止,closing_note 自动加 `[verified by X via mcp/web]` 前缀,照常通知依赖方)/ `verify_fail`(打回,fixed → active,owner 不变) |
| `heartbeat` | 写(游标) | 推进任务心跳,返回自上次心跳以来他人的新留言(activity)——这就是拉取式通知通道,`overlap_notice`、依赖关闭通知和 bug 打回通知天然流经这里。planned 任务无心跳,先 `claim_task`;**fixed 状态可调**(等回归期间借此接收打回通知) |

## v1.1 敏捷功能

- **planned/backlog 生命周期**:`planned --claim_task--> active --update_status--> done|abandoned`。`register_task` 传 `start_as='planned'` 预告自己将来的工作,`'backlog'` 登记无主条目人人可认领;planned/backlog 登记时不通知任何人,通知在 `claim_task` 认领那一刻触发。无 un-claim:认领错了 `update_status` 置 `abandoned` + 重新登记为 backlog。
- **迭代标签**:`iteration` 是自由文本 sprint 标签(如 `2026w24`),精确匹配才能分组/过滤——全队统一拼写,照抄 `list_tasks` 里已有的写法;`update_task` 可改,空串清除。
- **依赖通知**:`depends_on` 纯信息性,从不机械阻塞;被依赖任务关闭时,系统在每个依赖方任务下贴通知(RESOLVED / ABANDONED),依赖方下次 `heartbeat` 拉到。
- **站会摘要**:`get_standup` 工具 / `GET /api/standup` 端点,默认回看 24 小时(上限一周)。
- **红线新表述**:看板有 backlog,但**永不指派**——claim 永远是人类决定后 agent 自愿执行;不要把看板当待办队列自动找活。依旧没有 webhook、没有指派、没有 un-claim。

### v1.4 buglist(测试反馈闭环)

bug 是**带类型的任务**(`type='bug'` + `severity`),不是新实体——因此天然复用认领、留言协商、依赖通知和重叠检查(修 bug 声明的 scope 参与重叠检测是真实价值)。生命周期在任务状态机上扩展:

```text
planned/backlog --claim_task--> active --fix_ready--> fixed(待回归) --verify_pass--> done
                                  ^                      |
                                  +-----verify_fail------+   (打回:owner 不变,继续修)
```

完整研发流程对照(全部环节如何映射到看板):

| 研发环节 | 看板动作 |
|---|---|
| 订功能 | `register_task(start_as='planned'/'backlog')` 预告/挂出 |
| 分发 | 人类指给某人,其 agent `claim_task`(看板永不指派) |
| 开发/测试 | active + `heartbeat`;测试发现 bug → `register_task(type='bug', start_as='backlog', severity, description=复现步骤)` |
| 修复 | 修 bug 的 agent `claim_task` 认领 → 修完 `update_bug_state(fix_ready, note=修复说明+验证方法)` |
| 回归 | 报告者(或任何人)验证后 `update_bug_state(verify_pass/verify_fail)`;人类测试员用 `/board` 卡片按钮 |
| 继续 | `verify_pass` 关闭并通知依赖方;`verify_fail` 打回 active,owner 下次 `heartbeat` 收到通知 |

人类测试员(没有 agent)走纯浏览器通道:`GET /report-bug` 表单报 bug(身份记为 `<姓名>/human`),`/board` 上 fixed 的 bug 卡片直接点「回归通过 / 打回」。

## 团队接入

接入材料都在 [`adoption/`](adoption/) 目录,三步完成:

> **最快路径(推荐):对你的 agent 说一句话** —— "读 `http://<NAS地址>:8765/setup`,按里面的步骤完成接入"。该文档是写给 agent 看的,它会自主完成 MCP 注册、agent_id 约定、CLAUDE.md 协议写入、hooks 安装和验证。
>
> 人类想自己动手:浏览器打开 **`http://<NAS地址>:8765/onboard`**,页面已把所有片段准备好(地址已替换、可一键复制),照步骤 ①-⑤ 操作。以下为对应的仓库内文件说明。

1. **挂上 MCP server**:把 `adoption/mcp-config.snippet.json` 的内容合并进项目(或全局)的 `.mcp.json`,URL 改成你的 NAS 地址,例如 `http://nas.lan:8765/mcp`。
2. **写入协议**:把 `adoption/CLAUDE.md.snippet.md` 的内容贴进项目 `CLAUDE.md`,并把其中的 `agent_id` 固定为你自己的(`人名/agent 名`)。它包含接到任务时的标准流程、`.claude/board-task.json` 持久化约定(worktree 本地,记得 gitignore)、以及"不要把板子当任务队列"的红线。
3. **装 hook(推荐)**:按 `adoption/hooks/settings.snippet.json` 配置 SessionStart hook,指向 `adoption/hooks/board-check.sh`。它在会话启动时 curl `/api/board?owner=<agent_id>`(2 秒超时,失败静默,板子挂了绝不拖垮会话),把你自己的在途任务和协议提醒注入会话——解决 compaction 失忆和忘登记。

## 规范流程(agent 接到任务时)

```text
接到任务
  → (可选)get_standup     # 鸟瞰过去 24h:谁完成、谁开工、谁卡住
  → project slug:git remote get-url origin 的 basename,去 .git、转小写
  → check_overlap          # 干跑,看看谁在这片区域
  → 任务已在看板上(planned/backlog 条目)?
      是 → claim_task      # 认领;响应含认领前完整留言线程(必读)+ 新鲜重叠报告
      否 → register_task   # 登记即认领
    把返回的 task id 存入 .claude/board-task.json
  → (有 HIGH/MEDIUM 重叠)在对方任务下 add_comment 协商;收敛后 boundary_agreement 记录边界
  → 续作时 heartbeat       # 拉取他人新留言(含系统 overlap_notice、依赖关闭通知)
  → 完成时 update_status   # done/abandoned + closing_note(自动通知 dependents)
```

## 配置

全部通过环境变量(参见 [`.env.example`](.env.example) / `docker-compose.yml`):

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8765` | HTTP 端口(`/mcp`、`/board`、`/api/board`、`/healthz` 同端口) |
| `DB_PATH` | `./data/board.db` | SQLite 文件路径;**所在目录必须可写**(WAL 会生成 `-wal`/`-shm` 同目录文件) |
| `STALE_TTL_HOURS` | `8` | 超过该小时数无心跳的 active 任务被标 stale(见下) |
| `AUTH_TOKEN` | 未设置 | 未设置 = 内网免认证。设置后 `/mcp` 与 `/api/board` 要求 `Authorization: Bearer <token>`——取消 compose 里的注释即完成全部鉴权升级,客户端只需加一个 header |
| `ADMIN_TOKEN` | 未设置 | 运营入口 `GET /admin/feedback?token=…` 的门禁(查看全部反馈 + agents 活跃情况);未设置时该路径一律 404 |

## Staleness 语义

`stale := status == 'active' && last_heartbeat_at < now - STALE_TTL_HOURS`(默认 8 小时)。**读时派生,不落库**;看板和重叠报告会打 stale 标记,但 stale ≠ dead——任务**留在报告里**,服务端**永不**因 stale 自动关闭或转移任务。关闭任务只有 owner 调 `update_status` 一条路。

## 升级与回滚须知(v1 → v1.1)

- **自动迁移**:v1.1 启动时自动把 schema 从 v1 迁到 v2(单事务,失败回滚并拒绝启动);启动日志会打印 `schema_version`,升级后确认它是 `2`。后续版本同理:v1.3 → v3(加 feedback 表),**v1.4 → v4(tasks 表重建)**,均自动迁移,回滚一律 = 恢复升级前备份 + 旧镜像。
- **升级前先备份**(WAL 模式下不要直接 `cp`,见下方「备份」):

  ```bash
  docker compose stop
  sqlite3 data/board.db ".backup 'data/board-pre-v1.1.db'"
  docker compose up -d --build
  ```

- **回滚 = 恢复备份文件 + 旧镜像**:先停容器,把备份文件复制回 `data/board.db`(清掉同目录残留的 `-wal`/`-shm`),再用旧镜像启动。**直接换旧镜像配新库(schema v2)会崩**——旧代码不认识新表结构,且没有降级迁移。
- **升级期间在跑的 Claude Code 会话需要重启**才能看到 3 个新工具(MCP 工具列表在会话启动时拉取)。

## 备份

SQLite 在 WAL 模式下不要直接 `cp` 数据库文件(`board.db` + `-wal` + `-shm` 三件套可能不一致),用 `.backup` 在线备份。NAS crontab 示例(每天 3 点,路径按你的部署目录调整):

```cron
0 3 * * * sqlite3 /home/nas/tools/todo-list/data/board.db ".backup '/volume1/backup/board-$(date +\%F).db'"
```

## 开发

```bash
npm run dev            # tsx watch,热重载
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:coverage  # 覆盖率(整体阈值 80%,core 目标 ≥90%)
npm run build          # tsc + 拷贝 schema.sql / board.html 到 dist/
```

结构速览:

```text
src/
  index.ts config.ts    # bootstrap;config.ts 是唯一读 process.env 的地方
  core/                 # 纯逻辑零 I/O:slug 归一化、glob 配对、重叠引擎、staleness
  db/                   # schema.sql + better-sqlite3 连接(WAL pragma)+ repo 层
  mcp/                  # 工具 schema/描述 + 13 个工具实现(无状态 server)
  http/                 # Express 5:POST /mcp、看板、healthz、可选 Bearer 鉴权
  web/                  # board.html(零构建链 vanilla JS)+ boardData.ts
test/                   # unit(core 配对表)/ integration / smoke
adoption/               # 团队接入件:mcp 配置片段、CLAUDE.md 协议片段、hooks
```
