# Agent Task Board 协作协议

> 看板地址:`http://nas.lan:8765`(MCP server 名为 `task-board`;人看的网页在 `/board`)。
> 核心红线:**看板只提供信息,从不分派任务、从不拦截操作**。

## 身份约定

agent_id: <FILL_IN>

- 格式为 `<human>/<agent>`,例如 `alice/claude`,**跨会话保持稳定**。
- 上面那行就是身份声明:把 `<FILL_IN>` 换成你的固定值。所有看板工具调用都传这个 `agent_id`,SessionStart hook 也从这一行读取它。

## 规范流程(人类交给你开发任务时,写代码之前必须走完)

1. **推导项目与分支**
   - project slug = `git remote get-url origin` 输出的 basename,去掉 `.git` 后缀,全小写;仓库没有 remote 时退回用仓库目录名。
   - branch = `git branch --show-current`。
2. **先查重叠**:调用 `check_overlap`,传 project + 你打算触碰的路径 glob / 模块名。它是只读干跑,可反复调用。
3. **出现 HIGH/MEDIUM 对手时**:把情况告诉人类,并到**对方任务**下用 `add_comment` 协商边界;谈拢的分工用 `kind='boundary_agreement'` 的留言记录下来。看板只提供信息、永不阻塞——是否继续动工由人类拍板。
4. **登记任务**:调用 `register_task`(**登记即认领**)。把返回的 task id 写入工作树的 `.claude/board-task.json`,内容为 `{"task_id": "...", "project": "...", "registered_at": "..."}`;该文件保持 gitignore(不入库)。
5. **续作**:恢复一个已有 `board-task.json` 的工作树时,先调用 `heartbeat`,并**认真阅读**返回的 activity——别人的留言和系统贴的 overlap_notice 都从这条通道到达。
6. **收尾**:任务完成或放弃时调用 `update_status`(`done` | `abandoned`),**必须**附 `closing_note`(给下一个陌生 agent 看的),然后删除 `board-task.json`。

## 其他规则

- **绝不把看板当任务队列**:它没有队列、没有指派,任何"从板上领任务"的用法都是误用。
- 开发途中计划漂移到新文件/新模块时,调用 `update_scope` 更新你声明的边界(HIGH/MEDIUM 重叠会自动通知双方)。
