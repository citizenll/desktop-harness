<h1 align="center">
  <img src="build/app-icon.png" width="64" alt="DSH Desktop 图标" valign="middle" />
  DSH Desktop
</h1>

<p align="center">
  面向 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>
  的本地优先、跨平台桌面客户端。
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-171513.svg" /></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-171513.svg" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-171513.svg" />
  <img alt="Linux" src="https://img.shields.io/badge/Linux-x64-171513.svg" />
</p>

![DSH Desktop 的 Preset、模型提供方与手机控制能力](docs/images/dsh-desktop-hero-v020.png)

<p align="center"><strong>除了 DeepSeek 官方模型，DSH Desktop 也支持主流第三方模型提供方。更多基于 DSH 的有趣桌面体验即将推出。</strong></p>

DSH Desktop 把 DeepSeek Harness 的本地 Web 体验封装为桌面应用：应用会自动启动本地 Harness、管理随机回环端口、持久化 Profile/插件/会话，并在 Harness 就绪后直接进入完整界面。项目工作区在 Harness 界面中统一添加和管理。

> [!IMPORTANT]
> DSH Desktop 不是对上游 DeepSeek Harness 的简单打包。我们把高频能力固化并优化为桌面端内置功能，包括手机连接（局域网与临时公网通道）、插件市场、运行环境准备、自动更新与故障恢复。项目目标是提供一个真正开箱即用的 Harness 桌面端：安装后即可使用，无需再手动组合插件、配置服务或管理运行环境。
>
> 项目当前处于早期预览阶段，并跟随仍在快速迭代的 `@deepseek-ai/dsh@0.1.1-rc.1`。安装包与更新文件统一通过本仓库的 GitHub Releases 发布。

## 下载安装

请前往 [GitHub Releases](https://github.com/citizenll/desktop-harness/releases/latest) 下载 macOS、Windows 或 Linux x64 安装包。Linux 提供通用 AppImage 与 Debian/Ubuntu 使用的 `.deb`。

已安装的 macOS 和 Windows 版本会在启动后及每六小时从本仓库的 GitHub Releases 检查更新。更新将在后台下载，准备完成后提示重启安装；也可以从应用菜单选择 **检查更新…** 手动检查。

## 为什么做这个项目

DeepSeek Harness 本身提供完整的 Agent Runtime 与 Web UI。DSH Desktop 不重新实现 Harness，而是补上桌面产品所需的宿主能力：

- 无需手动运行 CLI 或管理本地端口
- 启动时自动创建应用专属的 Harness 启动目录
- 通过 Harness 内置目录选择器统一添加和管理项目工作区
- 统一管理 Harness 子进程、启动检测、日志与退出
- 把 Profile、插件和会话保存在应用安装目录之外，升级应用不丢数据
- 提供 macOS、Windows 与 Linux 安装包构建入口

## 功能

- 启动后直接进入 Harness，不设置额外首页
- 启动时无需先选择目录，自动创建并复用应用内部启动目录
- Harness 启动失败时支持重试、查看日志或退出
- Harness 菜单支持重启子进程与查看日志
- 退出桌面应用时优雅终止 Harness 子进程
- 每次启动仅监听随机的 `127.0.0.1` 端口
- Renderer 关闭 Node.js 权限，启用 `contextIsolation`、sandbox 与导航限制
- 在桌面窗口与 Harness 侧栏统一使用 DSH 品牌 Logo
- 手机端支持自动选择真实 Wi-Fi/以太网地址，也可按需开启临时 Cloudflare 公网通道；两种方式都必须在桌面端批准连接
- 可把完整的自定义 Agent 预设导入/导出为便携的 [`.dshpreset` 压缩包](docs/preset-packages.md)，安装前会检查命名冲突并提示信任风险
- 正式 DSH 应用图标，支持 macOS ICNS、Windows ICO 与 Linux PNG

## 快速开始

### 环境要求

- Node.js 22 或更新版本
- npm
- macOS Apple Silicon/Intel、Windows x64，或 Linux x64

### 本地开发

```bash
git clone https://github.com/citizenll/desktop-harness.git
cd desktop-harness
npm install
npm run dev
```

`npm install` 会运行 `patch-package`，重放 DSH Desktop 对 Harness 首次模型配置、Preset 压缩包导入导出和侧栏品牌的定制，安装品牌静态资源，然后安装 Electron Runtime。

### 质量检查

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` 只生成主进程和 Preload 的压缩 Bundle。需要检查最终发行目录时，使用 `npm run package:dir`；它会先构造 `.runtime/` 运行时暂存目录，再打包并验证产物。

### 打包

```bash
# 在当前 Mac 架构上生成未签名 DMG 与 ZIP
npm run package:mac

# 分别在对应架构的 Mac/CI Runner 上执行
npm run package:mac:arm64
npm run package:mac:x64

# 在 Windows x64 机器/Runner 上生成 NSIS 安装包
npm run package:win

# 在 Linux x64 机器/Runner 上生成 AppImage 与 DEB
npm run package:linux
```

Harness 包含架构相关原生模块。macOS ARM64、macOS Intel、Windows x64 与 Linux x64 应在对应平台上重新安装依赖并构建。架构专用脚本会在打包前检查当前 `platform/arch`，避免生成看似成功、实际缺少原生依赖的安装包。

发行构建不会把仓库根目录交给 Electron Builder 猜测。`scripts/prepare-runtime.mjs` 会从干净的生产依赖安装开始，应用固定补丁和品牌资源，只收集 Bundle、运行时资源与当前平台原生文件到 `.runtime/`。纯 JavaScript 和静态资源进入 `app.asar`，`.node`、DLL、EXE、WASM 等必须落盘的文件才会解包。Electron Runtime 同时作为 Harness 与 pnpm 的 Node Worker，因此安装包不再携带第二份 Node.js。

## 运行架构

```text
DSH Desktop (Electron Main)
├── 应用专属启动目录
├── Harness 子进程生命周期
├── 随机回环端口与启动检测
├── 原生日志/错误恢复入口
└── 安全 BrowserWindow
     └── http://127.0.0.1:<random>  DeepSeek Harness Web UI

Electron userData
├── launch-root/
├── logs/harness.log
└── harness/
    ├── profiles/
    ├── sessions/
    └── 插件与用户数据
```

Harness 运行在独立的 Electron Node 子进程中。Cordis HMR 所需的 `--expose-internals` 只授予该子进程，不会授予 Web Renderer。用户 Profile 中的插件仍按原目录加载；当它们引用 DSH 内置依赖时，桌面端的模块解析回退会从只读的 `app.asar` 运行时解析，不需要复制整套依赖到用户目录。

## 项目结构

```text
src/main/             Electron 主进程、窗口与 Harness 生命周期
src/shared/           共享运行时类型
patches/              对固定 DSH 版本的可复现界面定制
scripts/              运行时暂存、产物验证、品牌资源与平台检查
test/                 设置、运行时、安全和 Provider 覆盖测试
build/                应用图标、安装器资源与运行时模块解析入口
.runtime/             构建时生成的最小发行目录（不提交）
```

## 当前验证状态

- macOS Apple Silicon：开发运行、真实 Harness 启动、DMG 打包、代码签名、Apple 公证与挂载验证均已完成
- macOS Intel：打包配置与平台检查已提供，需要在 Intel Mac/Runner 上完成运行验证
- Windows x64：Electron Node Worker、真实 Harness 启动、Profile 插件依赖解析、原生模块与 NSIS 产物均已验证
- Linux x64：由 Ubuntu Runner 原生构建并验证 AppImage 与 DEB 发行产物
- Windows ARM64：当前不支持
- 自动更新：macOS 与 Windows 通过本仓库 GitHub Releases 检查和下载；Linux 当前从 Releases 手动更新

## 上游版本与补丁

项目当前固定依赖 `@deepseek-ai/dsh@0.1.1-rc.1`。首启 Provider 列表与桌面端 Preset 导入导出界面由 [`patch-package`](https://github.com/ds300/patch-package) 固化在 [`patches/`](patches/) 中，而不是依赖未跟踪的 `node_modules` 修改。侧边栏品牌标识与手机配对入口改为填充 Harness 提供的 `sidebar.brand.*` 与 `sidebar.footer.action` 插槽，不再需要补丁。

升级 DSH 时必须：

1. 核对上游 Settings/Credentials 与 Provider Directory 契约；
2. 重新应用或重写首启界面定制；
3. 重新生成补丁；
4. 完成真实 Harness 启动与 Provider 配置回归。

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请至少运行：

```bash
npm test
npm run typecheck
npm run build
```

请勿在 Issue、日志、截图或测试数据中提交真实 API Key。

## 许可证

本项目采用 [MIT License](LICENSE) 开源。

DeepSeek Harness 及其依赖仍遵循各自的上游许可证与商标规则。DSH Desktop 是独立的社区桌面封装项目。
