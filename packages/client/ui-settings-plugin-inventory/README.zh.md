# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

[English](README.md) | 中文

profile 扩展与受管 Harness 源码的浏览器 Settings 界面。该插件注册两个延迟加载的 `settings.plugins.tab` 贡献：**插件中心**（`center`）与 **源码与更新**（`source`）。激活阶段不执行 Remote 读取；Plugins 区域挂载对应 tab 时，组件才请求当前状态。两个注册均使用 `ctx.slots.inject()`，因此无需导入区域拥有者就能跟随延迟声明、重新声明、locale 变化与 teardown。

插件中心组合两个现有权威。`evolution/pluginsList` 提供安装所拥有的系统 bundle、可修改的 profile 扩展 bundle 与已安装库；`pluginInventory/list` 提供当前 Cordis Loader 条目与 Fiber 阶段。用户可安装显式 npm、Git、tarball 或绝对文件系统包规格，更新或移除可修改依赖，并在执行移除前二次确认。包修改成功时 Host 已重新组合；tab 随后刷新 renderer，使变化后的 Client 名册被发现。加载失败保持通用提示，显式修改失败则保留修复包或仓库输入所需的 Provider 诊断。

源码 tab 展示缺失、无效与就绪仓库状态。它可初始化打包的源码胶囊、获取官方分支、以仅快进或普通 merge 方式集成官方更新、配置独立的用户远程仓库，以及执行普通非强制 push。工作树不干净、分离 HEAD 或已有操作进行中时，集成与发布控件会被禁用。界面明确说明，成功源码操作只更新工作副本，尚不切换活跃运行时。

## 模型体验

无，因为本包只在浏览器 Settings 中展示特权 Host 配置，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **仅支持显式包规格** —— 签名目录、发布者元数据、兼容范围、组织策略、评论与价格属于未来的目录 Provider 工作。
- **运行时 Loader 清单表示调用当下** —— 运行时列表在 Settings 重新挂载或 Client 刷新时更新；它不订阅每一次 Fiber 转换。
- **源码激活已暂缓** —— 获取、merge 与 push 已实现，但经验证的代际构建、原子激活、回滚与安全模式尚未由该 Client 包暴露。
