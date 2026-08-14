# @deepseek-ai/dsh-source-repository

[English](README.md) | 中文

受管 DeepSeek Harness 源码工作区的 Service Definition。`SourceRepository` 拥有检查、首次实体化、官方获取与集成、用户远程仓库配置以及非强制发布的类型化操作和结果词汇。Provider 注册 `ctx.sourceRepository`；Consumer 不直接构造 Git 命令，也不直接检查仓库文件。

快照区分尚未创建的工作区、被非仓库文件占用的路径，以及就绪的 Git 工作树。就绪快照报告当前提交与分支、干净状态、未完成的 Git 操作、官方与用户远程仓库，以及已获取状态下的领先／落后计数。修改回执目前明确标记 `runtime: "unchanged"`：源码操作不声称已切换当前应用运行时。

## 模型体验

无，因为该 Service Definition 不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **不包含 Provider 策略** —— 可执行文件解析、仓库锁定、远程仓库校验、超时与文件系统效果属于 [`source-repository-git`](../source-repository-git/README.md) 等 Provider。
- **不激活运行时** —— 在实现经过验证的代际激活之前，当前回执词汇会明确报告活跃运行时未变。
