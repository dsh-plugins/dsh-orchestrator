# 复现编排器的集成版本

首次安装请使用 [dsh-prism 主仓库](https://github.com/dsh-plugins/dsh-prism)。这里的集成快照用于复现本次编排器提交与四个配套插件的行为。

编排器的每个集成版本都保存了 npm 工作区的根配置、依赖锁和跨插件测试。`peers.lock` 记录与当前编排器搭配的四个插件提交。需要有权读取这五个 GitHub 仓库的 Git 凭据，以及 Node.js 24.9 或更高版本。

在准备存放工程的目录运行以下命令。它们会创建一个新目录，按锁定的提交检出五个插件，并将工作区配置放到它们的上一级。

```sh
mkdir dsh-prism && cd dsh-prism
git clone --branch main https://github.com/dsh-plugins/dsh-orchestrator.git
git -C dsh-orchestrator archive HEAD:integration/workspace | tar -xf -
while read -r revision plugin; do
  git clone --no-checkout "https://github.com/dsh-plugins/${plugin}.git" "$plugin" &&
    git -C "$plugin" checkout --detach "$revision" || exit 1
done < dsh-orchestrator/integration/peers.lock

npm ci
npm test
```

需要复现历史版本时，在导出工作区配置前，将 `dsh-orchestrator` 检出到对应的提交。当前配置和 IM 接入方式请参阅[使用手册](https://github.com/dsh-plugins/dsh-prism/blob/main/README.zh_CN.md)及[技术文档](https://github.com/dsh-plugins/dsh-prism/blob/main/docs/TECH.md)。
