# @deepseek-ai/dsh-source-repository-git

[English](README.md) | 中文

[`ctx.sourceRepository`](../source-repository/README.md) 的本地 Git Provider。它从打包的 Git bundle 实体化已配置工作区；仅当允许且无源码胶囊可用时，才从官方仓库实体化。初始化会克隆到同级暂存目录，校验胶囊提交，删除胶囊远程仓库，安装仅获取的官方远程仓库，最后再将完整工作树重命名到目标位置，因此校验失败不会改动已配置根目录。

Provider 串行所有修改，并通过 `ctx.subprocess` 以精确 argv、显式工作目录、禁用终端提示、受限输出、截止时间与 teardown drain 运行 Git。官方更新拒绝工作树不干净、分离 HEAD 或已有操作进行中的仓库，获取已配置分支后执行 `--ff-only` 或普通 merge；冲突 merge 会在返回失败前中止。用户发布要求独立的非官方远程仓库、干净工作树与命名分支，并且只执行普通 `git push --set-upstream`；本包绝不强制推送。

远程仓库展示值会脱敏 URL 内嵌凭据，配置则拒绝内嵌 HTTP 凭据，也拒绝规范化仓库身份与官方仓库相同的用户远程仓库。身份验证仍由 Git Credential Manager、SSH agent 或其他 Git 凭据 Provider 拥有。

## 模型体验

无，因为该 Provider 不注册面向模型的贡献。

#### KV Cache 影响

无；仓库状态与诊断只达到同进程 Consumer 或特权 Remote 调用方。

## 已知限制与暂缓事项

- **仅修改源码状态** —— 成功修改返回 `runtime: "unchanged"`；它们不构建或激活新运行时代际。
- **单一已配置官方分支** —— 分支发现、Pull Request 工作流、冲突解决与历史重写不属于该 Provider。
- **Git 拥有身份验证** —— Provider 不存储凭据，也不打开交互式终端提示。
