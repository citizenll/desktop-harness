# Agent Note: Electron Desktop 通过零端口自定义协议复用共享 GUI 图

Status: implemented

[English](2026-08-14-electron-desktop-custom-protocol.md) | 中文

## Problem

现有 GUI 以浏览器应用交付，其组合默认依赖 HTTP 服务器、浏览器启动参数、WebSocket 下行和仅供 Web 开发使用的 HMR。Desktop 应用需要保留完整的插件化 Host 与 Client 体验，同时不能维护第二套前端、暴露 localhost 服务，也不能向 renderer 代码授予 Node 或 Electron 权限。

同一套 profile 机制必须继续作为内置组合包、用户插件、机器本地 patch、设置、凭据、会话和工具的权威来源。Electron 还改变了两个运行时事实：其主进程不暴露 Cordis Loader 的内部 ESM loader；通过 `process.execPath` 启动原生辅助程序时，如不额外处理，会再次启动 Electron 应用，而不是普通 Node worker。

## Decision

`apps/desktop` 是 Electron 主进程应用，通过共享的 `@deepseek-ai/dsh/profile-boot` 启动器加载内置 `desktop` profile。该 profile 依次叠加 `dsh-base`、`dsh-web-app` 与 `dsh-desktop-app`，因此 Desktop 会继承完整 GUI 名册，只修改应用特有的载体与交互行。

Electron 主进程把 `dsh` 注册为具备特权的标准安全 scheme，并只提供规范 origin `dsh://app/`。其协议 handler 会提供构建后的 Vite shell、外部启动清单脚本、Client 插件 bundle 与 sourcemap、独立于传输的 Host RPC 分派，以及 SSE 下行流。`/api` 路由优先于静态文件名分类，因为 `llm.providers` 等 Typert API 方法名包含点号。应用不开放 HTTP 监听端口，也不挂载 `dsh-host-webserver` 或浏览器 WebSocket 适配器。

## 载体与 Profile 组合

`dsh-client-modules` 始终持有启动图和 `clientPath(id)` 注册表。只有存在 `ctx.webServer` 时，它才激活 `/plugins` route 与 index 转换适配器；Desktop 协议会直接读取同一个注册表。`dsh-client-connection` 同样始终持有 `ctx.connection.fetch(request)` 与 RPC handler 注册表，而 `/api` route 和 WebSocket upgrade 是可选 Web 适配器。Renderer 选择 `EmbeddedApiClient`，通过 `globalThis.fetch` 请求 `dsh://app`，并沿用现有 fetch／SSE 编解码承载两条下行流。

`dsh-desktop-app` 会禁用 Web 启动、Web 服务器、Web runtime、Client HMR 与依赖绑定地址的目录选择器 chooser 行。它清除 Connection 行仅供 Web 使用的注入，固定使用原生目录选择器及对应 Client 界面，添加模型可见的 Electron 应用说明，并通过 shell environment 暴露 `DSH_DESKTOP_URL=dsh://app/`。Desktop shell 不会分叉或特殊处理对话、轨迹、终端、设置、凭据、agent preset 或工具界面。

## 安全与生命周期

Renderer 窗口启用 Chromium sandbox 与上下文隔离，并禁用 Node 集成、preload bridge、`<webview>`、不安全内容和跨 origin 导航。自定义协议的 index 会收到 Content Security Policy：它阻止内联与远程脚本，但允许同源文件和 `unsafe-eval`；Cordis Client loader 与动态 Client 插件需要运行时求值来编译来自可信 Host 的闭包。fetch、RPC 与 stream 连接仍限于同源，图片渲染则可以使用 data、blob、HTTP 或 HTTPS 来源。所有 Chromium 权限检查与请求都会被拒绝，新开的 HTTP 或 HTTPS 链接交给操作系统，其他导航一律阻止。普通启动使用 Electron 单实例锁，但应用菜单可以在同一个 Host 图上创建多个窗口。

应用关闭会先经过共享 profile 的 shutdown controller，再退出 Electron。Renderer 崩溃会被诊断，但 renderer 代码不会因此获得恢复权限。Desktop profile 会持续应用用户 patch 文件：可用时由 Cordis HMR 持有精确文件 watcher；嵌入式运行时则通过可移植轮询 watcher 提供相同的串行刷新与 `hmr/config-update-failed` 行为。

## 模块解析与打包

`mountRootInclude` 会在 Cordis Loader 内部模块 loader 存在时使用它。Electron 不暴露该 loader 时，已安装应用会提供 `bareModuleBaseUrl`；app boot 通过 `createRequire(base).resolve()` 解析裸包名，再导入得到的 file URL，而相对名称仍以配置文件为基准。

打包命令会构建全部产物，通过 pnpm workspace 注入与 hoisted node_modules 布局创建只含生产依赖的部署，再以应用声明的精确 Electron 版本运行 Electron Packager。Desktop manifest 会显式列出部署闭包中用于满足插件 peer dependency 的 Service Definition 包。产物不使用 ASAR，因为 profile、动态包解析和原生辅助程序都依赖普通文件系统路径。在 Windows 上，原生目录对话框只为自身 worker 子进程添加 `ELECTRON_RUN_AS_NODE=1`，使 `process.execPath` 运行已打包 Node 入口，同时不改变主应用环境。

## 验证

聚焦测试覆盖 Desktop 参数解析、协议路由与路径约束、profile 组合、模型和 shell 贡献、独立于传输的 Connection 与 modules 适配器、可移植 patch watcher、宿主模块解析回退，以及 Electron 特有的原生对话框子进程环境。隐藏的源码 smoke 会打开 renderer，并检查启动清单、已加载的 Client 模块图、渲染后的应用根节点，以及 renderer 对带点号 API 方法发出真实 POST 后返回的关联 server envelope。打包后的 Windows 可执行程序会在全新的 Harness home 中重复 smoke，并成功退出。

## 考虑过的替代方案

- **在 Electron 内启动 localhost HTTP 服务器** —— 拒绝，因为它会保留端口分配、Host header 与浏览器网络暴露，以及嵌入式同进程应用不需要的 WebSocket 生命周期工作。
- **`file://` 加 preload IPC bridge** —— 拒绝，因为 `file://` 的 origin 语义不理想，而 preload bridge 会增加第二套特权 API 界面，需要重复 fetch、流、校验和取消行为。
- **单独维护 Desktop 前端** —— 拒绝，因为它会让插件名册、模块 loader、UI 行为、sourcemap 和产品测试与 Web 应用分叉。
- **打包进 ASAR** —— 拒绝，因为普通文件系统路径是 profile、包解析、sourcemap 与原生辅助程序运行的一部分。

## Consequences

Desktop 与 Web 现在共享同一 GUI 插件图、启动清单格式、RPC 协议和已构建前端。Desktop 不开放监听端口，renderer 也不会获得 Node 或 Electron 权限。新 GUI 插件会通过现有组合机制同时出现在两个界面，除非某个 profile 层有意修改它。

Desktop 的 Client 插件 HMR 仍处于禁用状态，因此源码和 bundle 变更需要重新构建并刷新或重启应用。仓库会生成当前平台的未封装应用目录；代码签名、notarization、安装器、更新分发和跨平台发行编排仍由分发流程负责。
