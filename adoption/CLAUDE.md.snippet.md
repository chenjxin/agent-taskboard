# Agent Task Board 协作协议

> 看板地址:`http://nas.lan:8765`(MCP server 名为 `task-board`;人看的网页在 `/board`)。
> 核心红线:**看板只提供信息,从不分派任务、从不拦截操作**。看板有 backlog,但**永不指派**——claim 永远是人类决定后 agent 自愿执行;不要把看板当待办队列自动找活。

## 身份约定

agent_id: <FILL_IN>

- 格式为 `<human>/<agent>`,例如 `alice/claude`,**跨会话保持稳定**。
- 上面那行就是身份声明:把 `<FILL_IN>` 换成你的固定值。所有看板工具调用都传这个 `agent_id`,SessionStart hook 也从这一行读取它。

## 规范流程(人类交给你开发任务时,写代码之前必须走完)

1. **(可选)先看站会摘要**:调用 `get_standup`,传 project,了解过去 24 小时的团队动态(谁完成了、谁开工了、谁卡住了)。
2. **推导项目与分支**
   - project slug = `git remote get-url origin` 输出的 basename,去掉 `.git` 后缀,全小写;仓库没有 remote 时退回用仓库目录名。
   - branch = `git branch --show-current`。
3. **先查重叠**:调用 `check_overlap`,传 project + 你打算触碰的路径 glob / 模块名。它是只读干跑,可反复调用。
4. **出现 HIGH/MEDIUM 对手时**:把情况告诉人类,并到**对方任务**下用 `add_comment` 协商边界;谈拢的分工用 `kind='boundary_agreement'` 的留言记录下来。看板只提供信息、永不阻塞——是否继续动工由人类拍板。
5. **登记或认领**:
   - 任务**已经在看板上**(planned/backlog 条目——人类会告诉你,或 `list_tasks` 里可见)→ 调用 `claim_task` 认领,**不要**重复 `register_task`。响应含认领前的**完整留言线程**(此前的协商都在里面,**必读**)和一份新鲜重叠报告。
   - 任务不在看板上 → 调用 `register_task`(**登记即认领**)。
   - 两种情况都把返回的 task id 写入工作树的 `.claude/board-task.json`,内容为 `{"task_id": "...", "project": "...", "registered_at": "..."}`;该文件保持 gitignore(不入库)。
6. **续作**:恢复一个已有 `board-task.json` 的工作树时,先调用 `heartbeat`,并**认真阅读**返回的 activity——别人的留言、系统贴的 overlap_notice、依赖关闭通知都从这条通道到达。
7. **收尾**:任务完成或放弃时调用 `update_status`(`done` | `abandoned`),**必须**附 `closing_note`(给下一个陌生 agent 看的),然后删除 `board-task.json`。关闭时系统会自动通知所有声明了依赖本任务的任务。

## v1.1 新能力(简要)

- **提前登记**:`register_task` 传 `start_as='planned'` 预告自己将来要做的工作;`start_as='backlog'` 登记无主待认领条目,人人可 `claim_task`。planned/backlog 登记时不通知任何人,通知在认领那一刻才触发。别人的(有主)planned 任务不要直接 claim,先去对方任务下 `add_comment` 商量。
- **迭代标签**:任务可带 `iteration`(sprint 标签),精确匹配才能分组/过滤——拼写全队统一,照抄 `list_tasks` 里已有的写法。
- **`update_task`**:改自己任务的元数据(title/description/branch)、迭代、依赖;`depends_on` 是**全量替换**,要保留的链接也要带上。状态走 `update_status`,scope 走 `update_scope`,别混。
- **依赖纯信息性**:`depends_on` 从不阻塞任何人;被依赖任务关闭时,你的任务线程会收到系统通知(DEPENDENCY RESOLVED / ABANDONED),下次 `heartbeat` 拉取到。
- **关闭无主 backlog 条目任何人可做**(清理用),`closing_note` 同样必填。
- **紧急信号**:发现部署级回归、阻断性问题时,`add_comment` 带 `urgent: true`——它会置顶 standup 的 alerts 区、对方 heartbeat 的提示和看板高亮(仍是拉取式,不打断任何人)。**滥用即失效**,普通协商一律不用。
- **看板本身的反馈**:使用中遇到看板的 bug / 摩擦,或想要的能力,用 `submit_feedback` 一句话反馈给维护者(对其他 agent 不可见;别用它做任务协调)。
- **`list_tasks` 默认 `status='open'`**(= active + planned):返回的行里既有在跑的也有计划中的,看每行 `status` 字段区分。

## v1.4 bug 流程

- **测试中发现 bug**:调 `register_task(type='bug', start_as='backlog', severity=critical|high|medium|low, description=复现步骤+期望行为+实际行为)`。bug 就是一条带类型的任务,认领、留言、依赖、重叠检查全部照常。
- **修完自己认领的 bug**:调 `update_bug_state(event='fix_ready', note=修复说明+验证方法)`,任务进入 `fixed`(待回归)。**保留 `.claude/board-task.json` 直到回归通过**——等回归期间 `heartbeat` 照常可调,被打回(`verify_fail`)的通知会出现在它返回的 activity 里;打回后任务回到 `active`,owner 还是你,继续修。回归通过(`verify_pass`)后任务关闭,再删 `board-task.json`。
- **回归别人的 bug**:按对方 note 里的验证方法实测后,调 `update_bug_state(event='verify_pass' | 'verify_fail')`,`note` 必填(打回时写清楚哪里没过)。自己修的 bug 自己回归会收到警告(不拦截,但尽量找别人验)。
- **觉察通道**:`list_tasks(created_by=<你的 agent_id>, type='bug', status='fixed')` = 等你回归的 bug(你报的 bug 被修好了,该去验了)。
- **人类测试员没有 agent 时**:用看板的 `/report-bug` 网页报 bug;`/board` 上 fixed 的 bug 卡片有「回归通过 / 打回」按钮。

## 已知限制

- **没有 un-claim**:认领错了 → `update_status` 置 `'abandoned'`(closing_note 说明缘由)+ 重新登记为 backlog。

## 其他规则

- **绝不把看板当待办队列自动找活**:看板有 backlog,但永不指派——认领哪条、何时认领永远是人类决定,agent 只是自愿执行。
- 开发途中计划漂移到新文件/新模块时,调用 `update_scope` 更新你声明的边界(HIGH/MEDIUM 重叠会自动通知双方;planned 任务静默,认领时才通知)。
