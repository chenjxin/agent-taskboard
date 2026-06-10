# Agent Task Board

团队 agent 任务协调板。团队成员都通过 AI agent(主要是 Claude Code)开发时,互相看不见对方的进度:重复劳动、边界冲突到提交代码时才暴露。本工具部署在 NAS(内网)上:agent 开工时登记任务,其他 agent **接到任务时**先查一眼;任务声明边界(路径 glob + 模块名),后来者登记/查询时同步拿到重叠信号 + 对方是谁、在做什么、最近一次更新时间,双方在任务下留言协商边界与接口规范,把冲突消灭在写代码之前。**设计红线:这是信息板,永不编排、永不分派**——没有 assign / queue / next-task,staleness 只是提示,检查只返回信息和严重级别,从不裁决。

架构一行话:MCP Server(Streamable HTTP,无状态)+ SQLite(WAL)+ 只读 Web 看板,全部跑在一个容器里,端口 `8765`。

v1 没有 IM/webhook 推送:重叠信息对后来者(B)内嵌在工具响应里,对在位者(A)以系统 `overlap_notice` 留言形式贴在其任务下,A 下次 `heartbeat` / `get_task` 时拉取到。

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
| `GET /onboard` | 接入说明页:展示 adoption/ 全部片段(地址自动替换为当前访问地址),同事打开即可照做 |
| `GET /adoption/<name>` | 白名单方式提供 adoption 片段原文(/onboard 页面的数据源) |
| `GET /api/board` | 看板 JSON(也供 adoption hook 使用) |
| `GET /healthz` | 健康检查 |

## MCP 工具(8 个)

身份为自报的 `agent_id`,约定格式 `人名/agent 名`(如 `alice/claude-code`),无注册流程。

| 工具 | 类型 | 说明 |
|---|---|---|
| `register_task` | 写 | 登记任务即认领。单事务写入 task + scopes,响应内嵌重叠报告与警告(did-you-mean、broad glob、疑似重复等),并自动在重叠双方任务下贴对称 `overlap_notice` 系统留言 |
| `list_tasks` | 只读 | 按 `project` / `status`(默认 `active`)/ `owner` 过滤;行内带派生 `stale` 标志;上限 200 行。`owner` 传自己可在会话恢复后找回自己的任务 |
| `get_task` | 只读 | 完整任务字段 + scope 列表 + 全部留言线程 |
| `check_overlap` | 只读 | 干跑:不登记、不贴留言、可反复调用。**接到任务后第一步先调它** |
| `update_scope` | 写,**owner-only** | scope 全量替换,返回新重叠报告;HIGH/MEDIUM 触发对称通知(同一任务对仅在严重级别新增或升级时再贴,防刷屏) |
| `add_comment` | 写 | 留言协商。`kind`: `comment` / `boundary_agreement`(`overlap_notice` 为系统保留,提交即报错);边界收敛后用 `boundary_agreement` 记录结论 |
| `update_status` | 写,**owner-only** | 关闭任务:`done` / `abandoned`,**`closing_note` 必填**(关掉的任务对下一个陌生 agent 才有价值)。这是唯一关闭任务的途径,服务端永不自动关闭 |
| `heartbeat` | 写(游标) | 推进任务心跳,返回自上次心跳以来他人的新留言(activity)——这就是拉取式通知通道,`overlap_notice` 天然流经这里 |

## 团队接入

接入材料都在 [`adoption/`](adoption/) 目录,三步完成:

> 最快路径:浏览器打开 **`http://<NAS地址>:8765/onboard`**,页面已把下面所有片段准备好(地址已替换、可一键复制),照步骤 ①-⑤ 操作即可。以下为对应的仓库内文件说明。

1. **挂上 MCP server**:把 `adoption/mcp-config.snippet.json` 的内容合并进项目(或全局)的 `.mcp.json`,URL 改成你的 NAS 地址,例如 `http://nas.lan:8765/mcp`。
2. **写入协议**:把 `adoption/CLAUDE.md.snippet.md` 的内容贴进项目 `CLAUDE.md`,并把其中的 `agent_id` 固定为你自己的(`人名/agent 名`)。它包含接到任务时的标准流程、`.claude/board-task.json` 持久化约定(worktree 本地,记得 gitignore)、以及"不要把板子当任务队列"的红线。
3. **装 hook(推荐)**:按 `adoption/hooks/settings.snippet.json` 配置 SessionStart hook,指向 `adoption/hooks/board-check.sh`。它在会话启动时 curl `/api/board?owner=<agent_id>`(2 秒超时,失败静默,板子挂了绝不拖垮会话),把你自己的在途任务和协议提醒注入会话——解决 compaction 失忆和忘登记。

## 规范流程(agent 接到任务时)

```text
接到任务
  → project slug:git remote get-url origin 的 basename,去 .git、转小写
  → check_overlap          # 干跑,看看谁在这片区域
  → register_task          # 登记即认领;把返回的 task id 存入 .claude/board-task.json
  → (有 HIGH/MEDIUM 重叠)在对方任务下 add_comment 协商;收敛后 boundary_agreement 记录边界
  → 续作时 heartbeat       # 拉取他人新留言(含系统 overlap_notice)
  → 完成时 update_status   # done/abandoned + closing_note
```

## 配置

全部通过环境变量(参见 [`.env.example`](.env.example) / `docker-compose.yml`):

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8765` | HTTP 端口(`/mcp`、`/board`、`/api/board`、`/healthz` 同端口) |
| `DB_PATH` | `./data/board.db` | SQLite 文件路径;**所在目录必须可写**(WAL 会生成 `-wal`/`-shm` 同目录文件) |
| `STALE_TTL_HOURS` | `8` | 超过该小时数无心跳的 active 任务被标 stale(见下) |
| `AUTH_TOKEN` | 未设置 | 未设置 = 内网免认证。设置后 `/mcp` 与 `/api/board` 要求 `Authorization: Bearer <token>`——取消 compose 里的注释即完成全部鉴权升级,客户端只需加一个 header |

## Staleness 语义

`stale := status == 'active' && last_heartbeat_at < now - STALE_TTL_HOURS`(默认 8 小时)。**读时派生,不落库**;看板和重叠报告会打 stale 标记,但 stale ≠ dead——任务**留在报告里**,服务端**永不**因 stale 自动关闭或转移任务。关闭任务只有 owner 调 `update_status` 一条路。

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
  mcp/                  # 工具 schema/描述 + 8 个工具实现(无状态 server)
  http/                 # Express 5:POST /mcp、看板、healthz、可选 Bearer 鉴权
  web/                  # board.html(零构建链 vanilla JS)+ boardData.ts
test/                   # unit(core 配对表)/ integration / smoke
adoption/               # 团队接入件:mcp 配置片段、CLAUDE.md 协议片段、hooks
```
