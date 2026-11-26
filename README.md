<div align="center">

<img src="icon.svg" width="256" height="256" alt="dsh-orchestrator icon">

# dsh-orchestrator

**Give Prism separate models for talking to users, planning their requests and executing each step.**

English | [简体中文](README.zh_CN.md)

</div>

## Set up Prism

Use Node.js 24.9 or later, npm, Git and credentials with read access to the five private plugin repositories. The checkout script places matching plugins and launcher files in a local `runtime/` directory. Run subsequent installation, configuration and launch commands there. The public guide is available without signing in. To use the example models, configure your DeepSeek credentials in DSH or set the `DEEPSEEK_API_KEY` environment variable. [Installation guide](https://prism.dsh-plug.in/)

```sh
git clone https://github.com/dsh-plugins/dsh-prism.git
cd dsh-prism
node scripts/checkout.mjs
cd runtime
npm ci
npm run build
npm start
```

## Set up the model roster

In `runtime/`, copy the Prism example to `prism.config.json`. Under `orchestrator.models`, list the models available to each layer. Give every model an `id` recognized by its DSH provider and a `description` that explains when to choose it. For example, a quick search model and a cross-file analysis model give the planner two distinct choices.

| Layer | Who chooses the model | What it can do |
| --- | --- | --- |
| L1 · conversation | The user, in Web or IM | Query project metadata, contact planners, check progress and send visible replies. |
| L2 · planning | L1, when assigning a project | Break a task into steps, choose execution models and report to L1. |
| L3 · execution | L2, for each step | Use the granted tools in the planner’s project and return results. |

Set `orchestrator.defaultProjectId` and optionally `defaultL1Model`. Use `prompt` on individual models to supply role guidance. The default `append` mode adds it to the system prompt. Set `promptMode` to `replace` to provide the full system prompt. After restarting, open the model selector and check that the description and L1 choices match your configuration.

```sh
npm start -- prism.config.json --host 127.0.0.1 --port 3080 --no-open
```

[Prism documentation](https://prism.dsh-plug.in/) · [Technical reference](docs/TECH.md)
