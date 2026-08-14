# DeepSeek Harness Desktop

[English](README.md) | 中文

这个 Electron 应用复用已构建的 Web shell，以及与浏览器产品相同的 Cordis Host／Client 插件图。它在主进程中启动 `desktop` profile，通过具备特权的 `dsh://app` 自定义协议提供静态资源、Client 启动清单、插件 bundle、RPC 请求和 SSE 下行流，全程不开放 HTTP 监听端口。

Desktop profile 依次叠加 [`dsh-base`](../../packages/bundle/base/README.md)、[`dsh-web-app`](../../packages/bundle/web-app/README.md) 和 [`dsh-desktop-app`](../../packages/bundle/desktop-app/README.md)。最后一层移除仅供浏览器使用的启动、Web 服务器、Web runtime 与 Client HMR 行，并选择原生目录选择器。因此 renderer 可以保留完整的共享对话、轨迹、设置、凭据、agent preset、终端和工具界面，而无需维护分叉的前端。

## 开发

在仓库根目录运行：

```sh
pnpm run desktop
pnpm run desktop:built
pnpm run package:desktop
```

`desktop` 会先构建全部必需产物再启动 Electron，`desktop:built` 启动现有构建，`package:desktop` 则构建并打包当前平台。

打包产物默认写入 `.artifacts/desktop/DeepSeekHarness-<platform>-<arch>`。需要在另一份打包程序仍运行时验证替代版本，可通过 `DSH_DESKTOP_PACKAGE_OUTPUT` 指定其他输出根目录。打包步骤会先生成只含生产依赖、采用 hoisted 布局的 workspace 闭包部署，再调用 Electron Packager；产物不使用 ASAR，因为 profile 包、动态插件解析和原生辅助程序都需要普通文件系统路径。Windows 可执行文件会嵌入由 [`assets/icon.png`](assets/icon.png) 生成的多分辨率图标。

每个打包应用还会携带一个 Git 源码胶囊，它由本次打包所用的精确快照生成，并通过临时 clone 捕获未提交与未跟踪文件。提交胶囊前，打包流程会把其 staged Git tree 与当前工作区的 alternate-index tree 对比；只要存在缺失、多余或内容不同的文件，就会中止打包。源码设置页可以把该胶囊物化为 `$DSH_HOME/source/deepseek-harness` 下的 clean 仓库；因此用户或 Agent 开始定制前，无需在机器上另行手动 clone。

可执行程序接受 `--profile <name>`、可重复的 `--patch <file>` 和 `--devtools`。内部的 `--smoke-test` flag 会打开隐藏的 renderer，验证启动清单、已加载的 Client 模块图、渲染后的应用根节点，以及 `llm.providers`、`agentPreset.list` 等带点号方法的真实同源 RPC 调用，然后以适合构建验证的状态退出。

## 安全与生命周期

Renderer 启用 Chromium sandbox 与上下文隔离，并禁用 Node 集成、preload bridge 和 `<webview>`。Content Security Policy 会阻止内联与远程脚本，同时允许同源文件和 `unsafe-eval`；Cordis Client loader 与动态 Client 插件需要后者在运行时编译来自可信 Host 的闭包。fetch、RPC 与 stream 连接仍限于同源；图片可以使用 data、blob、HTTP 或 HTTPS 来源。所有权限请求都会被拒绝，导航被限制在 `dsh://app` 内，HTTP 与 HTTPS 链接交给操作系统打开。普通启动只保留一个应用实例，但菜单可以在同一 Host 图上创建多个窗口。应用关闭时会先排空共享 profile 的 shutdown controller，再退出 Electron。

## 已知限制与暂缓事项

- **Client bundle HMR 已禁用** —— 请重新构建受影响的产物，并刷新或重启应用。
- **托管源码尚未成为活跃 runtime generation** —— 初始化、fetch、merge 与 push 只作用于源码工作区，运行中的 Host 与 Client 仍使用打包构建。只有在已验证 generation 构建、原子激活、回滚与 safe mode 完成后，产品才能把任意 TypeScript 源码变更表述为应用更新。
- **发行链路由分发流程负责** —— 本仓库没有配置代码签名、notarization、平台安装器和自动更新。
- **打包以本机平台为单位** —— 每个目标都在对应操作系统上生成；仓库不包含跨平台发行自动化。
