# Desktop Harness

[English](README.md) | 中文

<p align="center">
  <img src="assets/desktop-harness-banner.png" alt="运行于 Windows 的 Desktop Harness" width="100%">
</p>

Desktop Harness 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Electron 桌面发行版。它保留官方 Cordis 架构——**一切皆插件**——并增加原生应用外壳、托管源码工作区、官方上游同步、用户仓库发布与插件中心。

**开发者预览：**首次正式版本发布前，接口、源码格式与桌面发行方式仍可能变化。

## 忒修斯之船式演进模型

桌面端采用“不可变 Electron 内核监管可变源码、Profile 扩展与已验证运行时代际”的设计。用户只需安装一次应用；随包附带的源码胶囊随后可以在 Harness 主目录中生成一个普通 Git 仓库，让用户或 agent 无需再次手动克隆项目，就能检查并定制完整产品。

官方代码与用户定制拥有彼此分离的权限。应用通过只用于获取的 `upstream` 远程仓库拉取并集成官方 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 历史；显式配置的 `origin` 则归用户所有，只执行普通的非强制推送。Profile 扩展继续复用现有 Harness Bundle 与 Cordis Loader 机制，不引入第二套插件格式。

当前版本不会宣称任意 TypeScript 修改能够立即替换正在运行的应用。源码初始化、获取、合并与推送只会更新托管工作副本；已验证代际构建、原子激活、回滚与安全模式仍是下一阶段的运行时里程碑。完整设计见[实时源码桌面演进方案](.agents/notes/proposed/architecture/2026-08-14-live-source-desktop-evolution.md)。

| 层级 | 职责 | 当前状态 |
| --- | --- | --- |
| Electron 内核 | 窗口生命周期、恢复界面、原生集成与零端口 `dsh://app` 载体 | 已提供；内核变更需要重新构建或通过签名应用更新发布 |
| Profile 扩展 | 导出 `dsh.bundle` 的 npm、Git、压缩包或本地软件包 | 已支持安装、更新、移除、Host 重组与渲染器重载 |
| 托管源码 | 从随包精确源码快照生成的完整 Git 工作区 | 已支持初始化、检查、获取、合并、配置用户远程仓库与推送 |
| 运行时代际 | 具备来源记录、验证、原子激活、回滚与安全模式的不可变构建 | 设计已完成；在实现前不会宣传实时源码激活 |

## 桌面版亮点

- **同一产品插件图：** 桌面端复用 Web 外壳以及相同的 Host、Client 插件清单；对话、轨迹、设置、凭据、预设、终端、工具与扩展界面保持共享。
- **不开放监听端口：** Electron 通过具备权限且同源的 `dsh://app` 协议提供静态资源、启动元数据、插件包、RPC 与事件流。
- **随包包含源码：** 每个桌面包都携带从精确打包快照生成的 Git 源码胶囊，并校验对本地已跟踪与未跟踪变更的捕获结果。
- **双仓库工作流：** 从 `upstream` 获取官方演进，通过普通合并保留本地提交，再将定制内容以非强制推送发布到用户拥有的 `origin`。
- **插件中心：** 检查系统 Bundle 与实时 Loader 条目，并通过随包 pnpm 运行时安装、更新或移除用户管理的 Profile 扩展。
- **原生工作区选择：** 桌面端使用操作系统目录选择器，而不是浏览器专用的文件系统提示。
- **加固的渲染器：** 默认启用 Chromium 沙箱、上下文隔离、远程脚本阻止、权限请求拒绝与外部链接系统接管。

## 运行

### 从源码运行

安装 Node.js `^22.19.0` 或 `>=24.0.0` 与 pnpm，然后运行：

```sh
git clone https://github.com/citizenll/desktop-harness.git
cd desktop-harness
pnpm install
pnpm run desktop
```

`pnpm run desktop` 会构建所需产物并启动 Electron。若要启动现有构建，请运行 `pnpm run desktop:built`。若要生成当前平台的应用包，请运行：

```sh
pnpm run package:desktop
```

打包结果写入 `.artifacts/desktop/DeepSeekHarness-<platform>-<arch>`。冒烟测试参数、打包行为、安全细节与当前限制见[桌面应用指南](apps/desktop/README.md)。

## 体验源码演进与插件

在桌面应用中打开**设置 → 插件**：

1. 使用**源码与更新**生成随包源码工作区、检查仓库状态、获取或合并官方分支、配置用户拥有的远程仓库，并推送干净分支。
2. 使用**插件中心**检查当前 Cordis 插件图并管理 Profile 扩展软件包。
3. 修改核心源码后重新构建并启动桌面端。Profile 软件包变更已经能够重组 Host，并在需要时重载渲染器；自动激活已验证源码代际的能力仍待实现。

## 架构与开发

桌面 Profile 依次叠加 [`dsh-base`](packages/bundle/base/README.md)、[`dsh-web-app`](packages/bundle/web-app/README.md) 与 [`dsh-desktop-app`](packages/bundle/desktop-app/README.md)。[`apps/desktop`](apps/desktop) 中的 Electron 入口负责应用生命周期，共享 Harness 软件包继续作为产品 API 与插件主干。

请先阅读[架构文档](docs/architecture.md)、[开发指南](docs/development.md)与[贡献指南](CONTRIBUTING.md)。Agent 还必须遵循 [AGENTS.md](AGENTS.md)。

## 上游与社区

Desktop Harness 构建于开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 项目、其开发者 [DeepSeek AI](https://deepseek.com) 以及 [Cordis](https://github.com/cordiverse/cordis) 之上。请为兼容插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，也欢迎加入 [DeepSeek Harness Discord 社区](https://discord.gg/Ycq5dCaS4)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
