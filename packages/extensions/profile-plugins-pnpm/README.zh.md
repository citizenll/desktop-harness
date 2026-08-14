# @deepseek-ai/dsh-profile-plugins-pnpm

[English](README.md) | 中文

[`ctx.profilePlugins`](../profile-plugins/README.md) 的固定版本 pnpm Provider。Provider 管理 `$DSH_HOME/profiles` 下一个已配置 profile，初始化缺失的 profile，并通过 `ctx.subprocess` 调用自身精确的 pnpm 依赖；它不使用系统 pnpm，也不构造 shell 命令。命令执行拥有显式 profile 工作目录、环境、截止时间、输出上限、终止宽限期、串行修改队列与 teardown drain。

安装接受 npm、Git、tarball 与绝对文件系统包规格。相对文件系统规格在该服务入口被拒绝；启动器调用方可在调用前将其锚定。pnpm 成功后，Provider 比较 profile 依赖，检测导出 `dsh.bundle.patch` 的已安装包，将这些包对齐到 `dsh.profile.bundles`，发出 `profile-plugins/changed`，等待 profile 重新组合，然后返回刷新后的包图。更新与移除只接受已由活跃 profile 拥有的依赖键。

pnpm 的依赖构建脚本策略保持生效。Provider 不启用生命周期脚本，也不把包元数据转换为执行权限。

## 模型体验

无，因为该 Provider 不注册面向模型的贡献。

#### KV Cache 影响

无；包操作与诊断只达到同进程 Consumer 或特权 Remote 调用方。

## 已知限制与暂缓事项

- **不解析目录** —— 用户提供显式包规格；搜索、签名、兼容范围与策略不在此实现。
- **不提供事务式包存储回滚** —— pnpm 拥有依赖安装。失败的 pnpm 命令保留其可恢复诊断，profile 层对齐与 Host 重新组合只在成功后运行。
- **Renderer 名册刷新** —— Host 重新组合在返回前完成，但已改变的 Client 包名册需要插件中心刷新 renderer。
