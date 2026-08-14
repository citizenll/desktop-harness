# extensions/：运行时扩展与受管演化

[English](README.md) | 中文

面向实时 Cordis 运行时与已安装产品 profile 的扩展机制：模型编写的动态包、受管 profile 依赖，以及用于官方更新与用户仓库发布的本地源码仓库。动态 runner 的浏览器半包仍位于此处而非 `packages/client/`，因为它们是该子系统 dual-half 包的一半；host 聚合排除它们，使每个 face 保持自己的 compiler program。设计来源：[动态工具集 Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) 与[桌面演化规范](../../.agents/notes/proposed/architecture/2026-08-14-live-source-desktop-evolution.md)。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | `cordis_inspect`／`cordis_define`／`cordis_run`／`cordis_stop`／`cordis_undefine` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的动态包 | 注册到 `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.md) | 定义注册表、host 半的 `node:vm` 沙箱，以及 request-run 往返 | 提供 `ctx.dynamicCordisRunner` |
| [`cordis-client-runner/`](cordis-client-runner/README.md) | 双半包的浏览器半：把定义求值成活的浏览器插件，并应答运行请求 | client 面；提供浏览器侧 `ctx.dynamicCordisRunner` |
| [`ui-cordis/`](ui-cordis/README.md) | 浏览器面：操作全部定义的全局面板，与只读的 define 卡片 | client 面；注册 slot |
| [`source-repository/`](source-repository/README.md) | 受管 Harness 源码 Service Definition | `ctx.sourceRepository` |
| [`source-repository-git/`](source-repository-git/README.md) | 用于胶囊初始化、官方更新与用户发布的本地 Git Provider | 提供 `ctx.sourceRepository` |
| [`profile-plugins/`](profile-plugins/README.md) | 活跃 profile 包管理 Service Definition | `ctx.profilePlugins` |
| [`profile-plugins-pnpm/`](profile-plugins-pnpm/README.md) | 内置 pnpm Provider 与 `dsh.bundle` 对齐 | 提供 `ctx.profilePlugins` |
