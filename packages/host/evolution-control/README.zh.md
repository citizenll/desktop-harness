# @deepseek-ai/dsh-host-evolution-control

[English](README.md) | 中文

受管源码与 profile 扩展所用的特权 Host Remote 网关。`EvolutionControlGateway` 消费 `ctx.sourceRepository` 与 `ctx.profilePlugins`，然后在 `evolution` namespace 下发布生成的直接方法，覆盖源码检查、初始化、官方获取与更新、用户远程仓库配置与推送，以及插件列表、安装、更新与移除。

网关不包含 Git、包管理器、文件系统或命令构造。它原样转发类型化输入与 Provider 回执，因此 Service Provider 仍是修改串行化、校验、超时与诊断的唯一权威。[`api-remotes`](../../api/remotes/README.md) 显式选取其生成的 Client 贡献，[`client/connection`](../../client/connection/README.md) 则将每个 `evolution.*` 方法归类为特权方法，使浏览器载体只允许 loopback，Electron 则使用内部 `dsh://app` origin。

## 模型体验

无，因为该 Host 配置网关不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；网关只能通过显式 Client Remote 调用访问。

## 已知限制与暂缓事项

- **传输准入不是用户身份验证** —— 远程暴露的多用户部署必须先增加已认证的权限层，才能启用该 namespace。
- **Provider 结果具有权威性** —— 网关不增加进度持久化、审计历史、目录元数据或运行时代际激活。
