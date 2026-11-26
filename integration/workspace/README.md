# dsh-prism · 棱镜

用户在 Web 或 IM 里发出一句指令，L1 选择项目和规划模型，L2 将工作分给本项目的一个或多个执行模型。多个项目可以位于不同设备。L1 用显式工具向用户发信，任务状态与只读会话入口跟随对话展示。

| TypeScript 插件 | 职责 |
| --- | --- |
| `@dsh-prism/dsh-concierge-ui` | 提供聊天、L1 模型选择、折叠任务卡和按需加载的会话查看器。 |
| `@dsh-prism/dsh-workspace-registry` | 根据主体过滤项目索引。仅受信任的宿主代码可从项目 ID 解析执行目录。 |
| `@dsh-prism/dsh-orchestrator` | 管理模型目录、角色预设、工具权限、持久消息队列、正式 DSH 会话绑定和任务状态。 |
| `@dsh-prism/dsh-mesh-node` | 将节点接入 DSH Subagent Provider，执行远程轮次、回传工具调用和读取轨迹。 |
| `@dsh-prism/dsh-im-gateway` | 将 Telegram 私聊映射为稳定的 L1 主体，投递主动消息、更新任务卡，提供其他 IM 可实现的传输接口。 |

## 运行

需要 Node.js 24.9 或更高版本及 npm。项目锁定 DSH `0.2.3-alpha.2`。在包含本文件的目录运行：

```sh
npm ci
npm test
cp prism.example.json prism.config.json
npm start -- prism.config.json --host 127.0.0.1 --port 3080 --no-open
```

打开 DSH 在终端打印的登录链接，即可进入棱镜。示例采用 DSH 自带的 `deepseek-official` 路由，实际对话需要在 DSH 凭据存储或环境变量 `DEEPSEEK_API_KEY` 中配置可用密钥。自动化测试自带可控的模型适配器。示例目录为工程本身，项目权限仅含检索和读取。可在 `registry.projects` 中换成实际项目，按项目配置原生工具。工作区、DSH 原生管理端点、模型思考记录均不会出现在聊天页面。

## 模型与会话

编辑 `orchestrator.models.L1/L2/L3` 配置各层模型。每条记录的 `id` 和 `provider` 选择 DSH 模型路由，`description` 是上级代理可查询的能力介绍。`promptMode: "append"` 追加层级与模型指令，`"replace"` 将模型提示词作为完整自定义系统提示词。权限由宿主工具过滤和调用拦截实施。各节点的模型 ID 必须能映射到该节点的模型路由。

L1 固定绑定 `defaultProjectId`，用户可以随时切换后续轮次使用的 L1 模型。L1 通过注册表选择授权项目和 L2 模型。L2 选择 L3 模型，每个执行步骤都继承 L2 的节点与工作区，派发时可以进一步收窄工具集合。对于跨项目的并行任务，L1 可将同一句请求派给多个不同项目的 L2。

所有轮次通过已注册的 `prism-<节点 ID>` Provider 启动。调度器签发单次派发凭据，在对应节点创建或恢复正式 DSH 会话，Provider 返回实际会话 ID。用户消息、子任务进度、双向收件箱与完成事件分别持久化。查看器按任务归属读取轨迹，不获取写锁。会话写锁冲突时由节点从原日志 Fork，通过事务发布新绑定，并记录旧会话的归档义务。

## 连接设备和 IM

在协调节点的 `mesh.peers` 声明目标节点的 ID、HTTPS 地址与保存共享令牌的环境变量名。在目标节点的 `mesh.incoming` 为来源节点配置同一令牌和允许派发的项目 ID。两端用同一项目 ID 与目的节点 ID 登记项目，实际目录由目标节点解析。目标节点重新验证主体、模型及工具上限，跨设备无需共享 SQLite 或文件系统。每台设备使用自己的 `DSH_HOME`。Mesh 请求使用独立令牌，与 Web 的登录 Cookie 分开。

例如，协调节点可配置 `{"nodeId":"hub","peers":[{"id":"studio","url":"https://studio.example.com","tokenEnv":"PRISM_STUDIO_TOKEN"}]}`。对应设备配置 `{"nodeId":"studio","incoming":[{"id":"hub","tokenEnv":"PRISM_STUDIO_TOKEN","projects":["mobile"]}]}`。在两端的 `registry.projects` 中将项目 `mobile` 绑定到 `studio`。设备间使用 TLS，回环地址支持 HTTP，供本机双节点测试使用。

启用 Telegram 时，将 `im.telegram` 设置为 `{"tokenEnv":"TELEGRAM_BOT_TOKEN","allowedUserIds":["你的数字用户ID"]}` 并在协调节点配置 Bot 令牌。打开 Bot 私聊，使用 `/models` 列出模型，使用 `/model` 切换，点击任务卡按钮读取会话。Web 使用 DSH 已认证的宿主所有者身份，同一宿主的已登录窗口共享对话。Telegram 按 Bot、私聊和发送者隔离，Web 与 Telegram 各自保留历史。

各插件目录中的 README 说明工具、路由、恢复语义和配置字段。端到端测试会启动真实 DSH Web 进程，在隔离临时目录中检查跨层权限、跨机执行、工作区继承、只读查看和可见消息。
