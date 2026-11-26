# 编排器技术参考

完整应用使用五个私有插件仓库，需要已获全部读取权限的 Git 凭据。在公开仓库根目录执行 `node scripts/checkout.mjs` 后进入 `runtime/`，再从该目录运行 npm、配置和启动命令。官网和使用文档可公开访问。[棱镜官网](https://prism.dsh-plug.in/)

`@dsh-prism/dsh-orchestrator` 为 DeepSeek Harness 建立 L1 交互、L2 规划和 L3 执行会话。Web 与 IM 插件通过 Cordis 服务 `ctx.prism` 提交用户消息、切换 L1 模型、获取公开状态和读取任务轨迹。

## 模型和项目

在插件配置中设置 `defaultProjectId`，并在项目注册表中向相应用户授权这个项目。三层分别配置至少一个模型。同一层的 `id` 唯一，`description` 为必填的能力介绍。可选的 `provider` 指向节点上已注册的 DSH 模型提供方。下例展示调度字段，模型 ID 需与实际配置相符。

```yaml
defaultProjectId: reception
defaultL1Model: chat-fast
executionTools: [read, glob, grep, edit]
models:
  L1:
    - id: chat-fast
      description: 中文对话与项目分流
      prompt: 先确认用户需要的结果，再决定是否派发。
  L2:
    - id: project-planner
      description: 多步骤规划、并行拆解与结果验收
      prompt: 先列出可交付结果，再派发执行步骤。
      promptMode: append
  L3:
    - id: code-worker
      description: TypeScript 代码阅读与编辑
      prompt: 在已授权的项目中完成分派的编码步骤，通过 send_parent 汇报结果。
      promptMode: replace
```

`append` 是默认模式，DSH 装配系统提示词时会保留原有提示词，并附加本层指令和模型提示词。`replace` 使用配置文本作为完整系统提示词，DSH 工具授权仍由运行时执行。上级调用 `list_models` 获取下一层模型的 ID 和介绍，派发时提交所选模型的 ID。用户切换 L1 模型后，新入队的消息使用新模型，已入队的消息保留接收时的模型。

## 派发和主动发信

| 层级 | 代理可用的调度工具 | 约束 |
| --- | --- | --- |
| L1 | `query_projects`、`list_models`、`dispatch_planner`、`send_child`、`get_progress`、`send_user` | 绑定默认项目。项目查询返回登记的元数据。只有调用 `send_user` 才会向该用户追加助手消息。 |
| L2 | `list_models`、`dispatch_executor`、`send_child`、`get_progress`、`send_parent`、`report_progress` | 使用 L1 指定的已授权项目。通过 `dispatch_executor` 拆分步骤，每次选择一个 L3 模型。 |
| L3 | `send_parent`、`report_progress`，以及授权的原生工具 | 服务端从 L2 继承工作区和节点。原生工具集合取节点配置、项目策略和逐级派发授权的交集。 |

两种派发工具都接收 `title`、`instruction`、`modelId` 和可选的 `permissions`。L1 派发还必须提供 `projectId`。返回的 `taskId` 可用于向自己的直接子任务发信、查询其进展和下属步骤。每次派发可以收窄后续任务权限。`executionTools` 可配置的原生 DSH 工具为 `read`、`read_image`、`glob`、`grep`、`write`、`edit`、`apply_patch`、`bash`，实际可用项还取决于宿主挂载的工具。启用 `bash` 会授予该执行节点配置的 shell 能力。

`send_parent` 和 `send_child` 将带来源的消息交付目标代理，即使对方已空闲也会触发新的会话轮次。`report_progress` 更新供上级查询的进展。子任务自己的消息轮次与下属任务都结束后，系统向其直接上级投递 `task_settled` 事件。L1 可据此向用户发信。公开任务卡只包含任务标题、层级关系、状态和更新时间；打开轨迹时按通道认证得到的用户和任务 ID 校验归属，然后只读查询 DSH 会话日志。

## 持久化与恢复

`conversations.sqlite` 以 SQLite 事务同时保存用户消息、任务状态、模型选择与待投递事件。Web 或 IM 携带同一用户范围内的 `requestId` 重试时会得到已有的对话快照。每个逻辑代理串行处理消息，独立任务可以并发执行。服务重启后继续处理已提交且尚未开始的轮次。若旧进程在执行工具期间退出，恢复时会将该轮次记录为失败并通知任务上级，以避免重复执行可能已经生效的操作。L1 用户消息会得到相应的投递状态。

DSH 自身保存正式会话事件。节点侧 `sessions.sqlite` 保存逻辑会话到 DSH 会话的绑定。激活遇到实际所有权锁冲突时，从原会话日志生成 Fork 并以事务重新绑定，原会话进入归档。归档义务持久化，可在下次激活时重试。只读轨迹入口不会激活代理。

## 安装与验证

公开的集成仓库记录配套插件版本。检出脚本从编排器归档中恢复工作区配置和端到端测试；进入 `runtime/` 后可运行 `npm test` 验证完整链路。[棱镜集成仓库](https://github.com/dsh-plugins/dsh-prism)
