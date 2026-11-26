<div align="center">

<img src="icon.svg" width="256" height="256" alt="dsh-orchestrator 图标">

# dsh-orchestrator

**为棱镜分别配置面向用户、规划任务和执行步骤的模型。**

[English](README.md) | 简体中文

</div>

## 接入棱镜

需要 Node.js 24.9 或更高版本、npm、Git，以及对五个私有插件仓库的 Git 读取权限。检出脚本把匹配的插件和启动文件放入本机的 `runtime/` 目录，后续安装、配置和运行命令均在该目录执行。公开使用指南可直接阅读。需要调用示例模型时，请先在 DSH 凭据存储中配置 DeepSeek 凭据，或设置环境变量 `DEEPSEEK_API_KEY`。[安装指南](https://prism.dsh-plug.in/zh/)

```sh
git clone https://github.com/dsh-plugins/dsh-prism.git
cd dsh-prism
node scripts/checkout.mjs
cd runtime
npm ci
npm run build
npm start
```

## 配置可选模型

在 `runtime/` 中把示例配置复制为 `prism.config.json`，在 `orchestrator.models` 下分别列出各层可用模型。为每个模型填写 DSH 提供方可识别的 `id`，并用 `description` 说明适用场景。例如，为执行层提供一个适合快速检索的模型和一个擅长跨文件分析的模型，便于规划代理按步骤选择。

| 层级 | 谁选择模型 | 主要能力 |
| --- | --- | --- |
| L1 · 交互 | 用户在 Web 或 IM 中选择 | 查询项目元数据、联系规划代理、检查进度并主动向用户发信。 |
| L2 · 规划 | L1 派发项目任务时选择 | 拆分步骤、选择执行模型并向 L1 汇报。 |
| L3 · 执行 | L2 为每个步骤选择 | 在规划代理的项目中使用获准工具，返回执行结果。 |

设置 `orchestrator.defaultProjectId`，还可设置 `defaultL1Model`。每个模型可用 `prompt` 配置角色指令。默认的 `append` 模式将内容附加到系统提示词，将 `promptMode` 设为 `replace` 则提供完整系统提示词。重启后打开模型选择器，检查显示的 L1 模型与介绍是否与配置相符。

```sh
npm start -- prism.config.json --host 127.0.0.1 --port 3080 --no-open
```

[棱镜使用指南](https://prism.dsh-plug.in/zh/) · [技术参考](docs/TECH.md)
