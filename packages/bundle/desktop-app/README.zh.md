# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

这是叠加在 [`dsh-web-app`](../web-app/README.md) 之上的 Electron profile 层。它的 [`cordis.patch.yml`](cordis.patch.yml) 保留共享的 Host 与 Client 插件名册，同时禁用仅供浏览器使用的启动参数、HTTP 服务器、Web runtime 和 Client HMR 行。它清除 Connection 行对 `webRuntime` 的注入，使 Electron 主进程可以通过 `ctx.connection.fetch()` 分派受信任请求；同时把依赖绑定地址判断的目录选择器替换为原生后端及其对应的 Client 界面。

该包不创建窗口，也不注册 Electron 协议。[`apps/desktop`](../../../apps/desktop) 负责应用生命周期，并通过安全的 `dsh://app` 协议提供已构建的 Web shell、启动清单、Client bundle、RPC 调用和 SSE 下行流，全程不开放监听端口。

## 模型体验

### Desktop 界面系统提示词

#### What the model sees

位于 order -98 的 `app:desktop-surface` 段落，排在逐请求变化的上下文之前。它把 DeepSeek Harness Desktop 确立为“这个应用”和“这个窗口”的默认指代对象，说明哪些 renderer 上下文不会被隐式提供，标明不开放端口的 `dsh://app` 载体，并给出源码变更后的重新构建与重启规则。

##### Verbatim section

```markdown
You are interacting with the user through the DeepSeek Harness Electron desktop application. When the user refers to "this app", "this window", or "the desktop app" without naming another target, they mean this application. The renderer provides no implicit DOM, route, screenshot, or selected-file context. The desktop application runs the Host and Client plugin graph in one process tree and serves the built Web shell through dsh://app without a listening port. Source changes require rebuilding the affected artifacts and restarting this desktop application before verification. Starting a separate Web server does not update this desktop window.
```

#### Token effect

只要挂载了这一 profile 层，每次请求都会带有一个固定的系统提示词段落。

#### KV Cache 影响

该段落只注册一次，位于系统提示词前部，并且只会随应用界面约定变化，因此其前缀可跨轮次稳定复用。

### Shell 环境 URL

#### What the model sees

Shell 工具会收到 `DSH_DESKTOP_URL=dsh://app/`；当模型检查或使用工具环境时，该值会进入模型可见内容。

#### Token effect

在 shell 输出包含该变量，或命令把它用于模型可见输出之前，不增加 token。

#### KV Cache 影响

不直接影响提示词。任何暴露该值的 shell 输出都追加在可复用的请求前缀之后。

## 已知限制与后续工作

- **Client 插件热替换已禁用** —— Desktop 加载已构建的 Client bundle，并支持完整窗口刷新；实时 bundle 重建通知仍属于 Web 开发流程。
- **仓库不组装发行分发链路** —— 应用可以在本地打包，但代码签名、notarization、安装器和更新分发仍由发行流程负责。
