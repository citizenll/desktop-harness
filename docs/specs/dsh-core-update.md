# DSH Desktop 独立内核更新规范

## 目标

已发布的 DSH Desktop 必须能够自动发现由本仓库构建并认证的新 DSH Core Runtime。用户确认后，Desktop 下载、验证、安装并激活新内核；激活只重启 Harness，不重启 Electron，也不要求重新安装桌面应用。

“自动更新”在本规范中的唯一含义是：自动检查并提示。Desktop 不得静默下载、静默安装或在会话运行中自行重启 Harness。

## 问题本质

当前 DSH 与 Electron Host 一起安装在 `app.asar/node_modules`，入口、pnpm、品牌资源和补丁路径均由 Host 直接解析。这种结构没有可替换边界：修改内核等同于修改已签名的应用目录，直接从 npm 或 Git 仓库安装又无法保证 Desktop 补丁、依赖闭包、原生 ABI 和发布验证一致。

因此，内核更新的发布单位不能是一个上游 npm 版本，而必须是本仓库 CI 产出的、封闭且可验证的 Desktop Core Runtime。

## 架构边界

### Desktop Host

Host 只负责：

- Electron main/preload、窗口和系统能力；
- Core Runtime 的选择、启动、停止和状态展示；
- 应用更新与内核更新协调；
- 下载、签名验证、事务安装和激活。

Host 不得：

- 导入任何 `@deepseek-ai/dsh-*` 运行时代码；
- 从应用目录推断多个候选内核；
- 修改 `app.asar`；
- 使用 npm、pnpm、bun 或 yarn 在线组装内核；
- 通过解析非结构化日志判断内核协议状态。

### Desktop Core Runtime

Core Runtime 是一个按平台和架构构建的闭包，包含：

- 同一 release train 的 DSH 包；
- `patches/manifest.json` 管理的 Desktop 补丁；
- `dsh-desktop-market`；
- `dsh-desktop-plugin-runtime`；
- Desktop patch 配置、Web UI、品牌资源；
- 插件安装所需的固定 pnpm；
- 当前平台和架构需要的原生模块及可执行文件。

内置基线 Core 与在线 Core 必须经过同一个 staging、裁剪、清单生成和验证流程。

### Core Runner

Desktop 安装包提供固定版本的独立 Node Runner。Harness 和插件工具链均由该 Runner 执行，不再复用 `ELECTRON_RUN_AS_NODE`。

原因是 Electron Node ABI 随桌面壳升级而变化；继续复用 Electron 会让已下载内核隐式依赖某个 Electron 版本，破坏独立更新边界。Runner 版本与 ABI 只能通过完整 Desktop 更新改变。

## 版本与兼容协议

每个 Core 使用单调递增整数 `generation` 排序。DSH SemVer 只用于展示，不能决定升级顺序。

Core 清单至少包含：

- `schemaVersion`；
- `generation`；
- `coreId`；
- `dshVersion`；
- `patchsetHash`；
- `desktopProtocol`；
- `runnerVersion` 与 `runnerAbi`；
- `dataSchema`；
- `platform` 与 `arch`；
- 归档格式、字节数、SHA-256 和不可变下载地址；
- 发布时间、过期时间和发布说明。

只有以下字段全部精确匹配，Core 才能被提示和激活：

- `desktopProtocol`；
- `runnerAbi`；
- `dataSchema`；
- `platform`；
- `arch`。

需要改变 Host 协议、Runner ABI 或用户数据 Schema 的版本，不属于独立 Core 更新，必须随完整 Desktop 版本发布。

## 信任模型

稳定通道清单必须使用 Ed25519 签名。Desktop 在解析清单内容前验证签名，并校验：

- 签名公钥标识；
- 清单过期时间；
- `generation` 不低于应用内置基线和本机已见最高版本；
- 目标平台、架构和协议兼容；
- 下载字节数和 SHA-256。

GitHub 和 TLS 只承担传输，不构成发布授权。签名私钥仅存在于发布工作流密钥中，公钥随 Desktop Host 发布；公钥轮换必须通过完整 Desktop 更新。

macOS Core 内的 `.node`、dylib 和可执行文件必须使用与 Desktop 相同的 Team ID 签名并完成 notarization。不得关闭 Library Validation。

## 本地存储

Core Store 固定为：

```text
userData/core-runtime/
  active.json
  highest-seen.json
  store/<core-id>/
    core.json
    artifact.json
    runtime/
  staging/<operation-id>/
```

`active.json` 是唯一生效指针，使用临时文件、刷新和同卷原子替换提交。`artifact.json` 固化已验证归档的文件名、字节数和 SHA-256，使下载完成后即使 Desktop 重启也能继续等待用户激活，而不重复下载。Core 目录在提交后按不可变对象管理：Host 与 Runner 运行期不得修改，同一目标平台的同一 generation 出现不同描述符或归档时必须拒绝。`core-id` 同时绑定 generation、平台和架构，使 macOS x64 与 arm64 的合法同代产物互不冲突。

Core Runtime 自身的包版本由 `generation` 唯一决定，不得继承 Desktop App 版本。每个目标完成签名后的 staging 必须按固定路径顺序、无归档时间戳方式连续打包两次并得到相同哈希；否则不得发布。generation 一经发布禁止重建或覆盖，后续 Desktop App 发版只能复用该不可变资产。

全新安装从应用资源中的基线 Core 归档走同一安装流程，不保留 `app.asar/node_modules` 直启路径。若已提交的 Core 缺失或损坏，Desktop 明确报错，不静默切换其他路径。

Desktop 升级携带更高 generation 的基线时，只把它作为已认证的本地候选和最低已见版本；只要当前 Core 仍与 Host 精确兼容，就继续运行当前 Core，并立即按正常更新流程提示用户。用户确认准备后，Host 从安装包内的归档完成哈希验证和 staging，不发起网络下载；用户再次确认后才激活。只有 Host 协议、Runner ABI 或运行目标已使当前 Core 不兼容时，才能在启动阶段切换到兼容的内置基线；目标架构切换允许使用同一 generation 的另一目标产物。同一目标的同一 generation 对应不同描述符属于发布错误，必须拒绝启动。

## 检查与交互

- Harness 首次成功启动后，延迟 15–30 秒自动检查；
- 之后每 6 小时检查一次；
- 从睡眠恢复且距离上次检查超过 6 小时时检查；
- 自动检查失败只写更新日志，不打断用户；
- 手动检查必须展示准确错误；
- 发现兼容更新时展示版本、大小和发布说明；
- 用户确认后才开始下载；
- 下载并验证完成后，用户确认才激活；
- 激活只重启 Harness；
- 正在执行的会话不会被后台更新主动中断。

所有交互使用 App 内统一 Dialog/Panel，不使用原生消息框。

## 事务安装与激活

安装状态机固定为：

```text
available
  -> downloading
  -> verifying
  -> staged (等待用户确认激活)
  -> activating
  -> active
```

任何失败进入 `error`，但不得修改 `active.json`。

激活步骤固定为：

1. 停止当前 Harness；
2. 使用候选 Core、真实 Profile、Desktop 补丁和插件图启动 Harness；
3. 等待 Runner IPC、HTTP 健康检查和 Renderer 启动信号全部稳定；
4. 原子提交 `active.json`；
5. 保持候选 Harness 页面继续运行。

候选 Core 未到达 `ready` 时，事务没有提交，Desktop 重新启动提交前的 Core。这是原子事务的回滚语义，不是多路径兼容兜底。

## 发布

- 每个 Core generation 发布为不可变 GitHub Release，例如 `core-g42`；
- 稳定指针发布在独立且不设为 Latest 的 `core-channel-stable` Release；
- 一个签名清单包含 Windows x64、macOS x64/arm64、Linux x64 资产；
- 所有目标构建、签名和真实启动验证通过后，才能更新稳定指针；
- Desktop 正式发布必须验证签名清单并嵌入对应 generation 的原始不可变归档，不得在 Desktop 工作流中重新构建同名基线；
- Core Release 不得影响 Desktop App 的 `latest.yml`、`latest-mac.yml` 或 Latest Release。

## 禁止项

- 不在客户端执行 `npm install @deepseek-ai/dsh@latest`；
- 不下载并执行未经本仓库认证的上游 tarball；
- 不修改应用安装目录；
- 不使用 SemVer build metadata 作为升级顺序；
- 不实现 beta、灰度、多源或镜像回退；
- 不保留旧的硬编码 Core resolver；
- 不为协议不匹配增加兼容分支；
- 不在独立 Core 更新中执行不可逆数据迁移。

## 验收标准

1. 全新安装在离线状态下可由内置基线 Core 启动。
2. 自动检查只提示，不下载。
3. 用户确认后才产生网络下载和磁盘 staging。
4. 错误签名、过期清单、降级版本、错误平台、错误 ABI、大小或哈希不符均不能进入 staging 完成态。
5. 下载、解压、验证、停止和候选启动任一步骤失败，`active.json` 都保持原值。
6. 激活成功只重启 Harness，Electron PID 不变。
7. 带现有插件和真实 Profile 的候选 Core 必须通过验证与启动。
8. Windows x64、macOS x64/arm64、Linux x64 的正式包均通过 Core 启动和升级冒烟测试。
9. Root Desktop runtime 不再包含 DSH release train，Host bundle 不导入或打包 `@deepseek-ai/dsh-*` 运行时代码。
