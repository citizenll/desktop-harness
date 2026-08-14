# Agent Note: Win32 文件夹选择器迁至 koffi 子进程

Status: implemented

[English](2026-08-02-win32-in-process-folder-dialog.md) | 中文

## 问题

Windows 目录选择器的主层此前是围绕 WinForms `FolderBrowserDialog` spawn 出的 PowerShell 脚本：只有恰好安装了 PowerShell 7 的机器才有现代对话框；一处回归——PowerShell 6 可解析却没有 WinForms（退出码 1 而非 `ENOENT`，5.1 回退永远不会触发）；`SetProcessDPIAware` 只有系统 DPI 的上限；选择器的行为取决于机器装了哪些 shell，而不是取决于 Windows 本身。

## 决策

`packages/host/directory-picker-native` 现在经 koffi——它已是仓库其他 `win32.ts` 代码的工作区依赖——在进程内打开 `IFileOpenDialog`（`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`），作为 win32 主层。COM 会话运行在 spawn 出的子进程中，模态 `Show` 永不阻塞宿主事件循环；子进程在阻塞前上报其原生线程 id，驱动层通过向该线程的窗口反复投递 `WM_CLOSE`（`EnumThreadWindows`）来处理中止请求，关闭等待预算耗尽后强制终止子进程。对话框是子进程的第一个窗口，Windows 会自动激活它，无需手动前台调用。子进程线程启用宿主接受的最佳线程 DPI 感知（`SetThreadDpiAwarenessContext`，按 per-monitor-v2 → per-monitor → system-aware 级联并检查返回值），严格优于脚本的系统 DPI 上限；DPI 保持为纯外观的 best-effort——不接受其中任何一种的宿主仍得到现代对话框，而不会降级。`IShellItem::GetDisplayName` 返回的路径通过 koffi 的 NUL 终止 `decode.string16` API 解码，并在 `finally` 块中通过 `CoTaskMemFree` 释放；绑定不会在 COM 分配上创建任意固定长度的内存视图。模块切分让覆盖率在任何主机上都诚实：`win32-dialog-logic.ts`（纯时序）与 `win32-dialog.ts`（driver）可在任何平台使用 fake 进行测试；`win32-dialog-bindings.ts` 针对 mock 的 `koffi` COM 世界测试 vtable 分派、NUL 终止路径解码与清理（`dsh-session-persistence-jsonl` 的技法）；POSIX 主机运行真实的 spawn 管道，并验证其因 koffi 加载失败而拒绝；win32 主机运行真实的打开对话框并通过中止将其关闭的冒烟测试。先于本层存在的 PowerShell 链已被删除（见[链删除](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)）：该层无回退。

## 考虑过的替代方案

- **预编译原生辅助程序（`native/` 家族，如 `@deepseek-ai/node-addon-landlock-run`）。** 否决：再增加一个 npm 包家族、MSVC 环境配置和 Windows 构建／发布通道——只为交付约 150 行仓库目前无法通过 CI 检验的 C 代码（现有 CI 没有真 Windows 通道）；koffi 以零新增供应链提供同一 COM 接口。
- **N-API 进程内插件。** 否决：同样的 CI／工具链原因，还需自行维护处理 STA 线程与消息泵的 C++ 代码，而子进程 + koffi 用 TypeScript 就能表达。
- **保留 PowerShell 为主层并探测版本。** 否决：选择器仍被 shell 打包形态挟持（6 与 7、Store 别名、profile），且没有 pwsh 的机器仍只能使用 5.1 的旧版对话框；只有拓宽回退触发条件这一项改动被纳入了回退层。
- **在主线程上阻塞模态调用。** 直接否决：对话框打开期间 web 宿主必须继续服务 RPC。

## 后果

- 每台 Windows 机器都得到带其所支持的最佳 DPI 感知（1703+ 为 per-monitor-v2）的现代对话框，无论是否安装 PowerShell。
- 真实对话框的渲染与完成选择仍是 Windows 发布检查；自动化的打开／中止冒烟测试无需交互式桌面即可证明打开、中止与收尾。
- 所用 COM vtable 槽位与 GUID 是冻结的 Windows ABI（Vista 起）；koffi 签名错误或无界原生内存读取可能引发原生访问冲突，但被限制在对话框子进程内——宿主 Node 进程存活，失败会连同退出码与信号原样上报（无回退层；见[链删除](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)）。mocked-koffi 的 ABI 固定测试与真实 win32 冒烟测试正是为了在交付前捕获这类错误。
- 打包二进制路径——打包后的可执行文件以对话框入口形式自我 spawn——不受自动化测试套件覆盖：源码与构建后 worker 测试固定协议和解码器，Windows 发布冒烟测试则通过打包后的 Electron 可执行文件接受一个真实文件夹。
