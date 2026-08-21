# 内置插件市场维护说明

DSH Desktop 把插件市场视为应用能力，而不是用户需要安装的插件：

- `dshmarket` 以精确版本记录在根 `package.json`，正式构建和 CI 不依赖本机的相邻仓库。
- `dsh-desktop-plugin-runtime` 只提供固定 Desktop profile 与随应用打包的 pnpm 执行边界。
- `build/dsh-desktop.patch.yml` 先挂载运行时桥，再挂载 `dshmarket`。
- Desktop 通过补丁把市场的 `发现 / 主题 / 已安装 / 高级` 投影到默认“插件”页面；非 Desktop 宿主仍保留上游独立市场页面。
- 分组标签元数据挂在市场组件的 `settingsPluginViews` 上。不要放进 `slots.register()` 的自定义字段：SlotCore 只保留通用的 `id/order/label/priority`，未知字段会被有意丢弃。
- 嵌入模式只在确有状态横幅或操作时渲染市场头部，并保持吸顶搜索区高度不随滚动状态变化，避免空白和 sticky 阈值反馈抖动。
- 启动迁移只清除旧 profile 中的 `dshmarket` 注册和链接，不删除用户通过市场安装的插件，也不删除市场配置、备份或状态。

## 跟随上游更新

1. 在独立的 dsh-market checkout/worktree 中切到目标发布版本，确认其 `package.json` 版本。
2. 更新精确依赖：`npm install --save-exact dshmarket@<version> --ignore-scripts`。
3. 把 Desktop 的嵌入适配移植到该版本源码并执行上游的 typecheck、test、build；不要直接依赖 `D:\Dev\self\dsh-market`。
4. 只复制构建后的 `client/client.js` 与对应源码到本项目的 `node_modules/dshmarket`，然后运行：
   `node node_modules/patch-package/index.js dshmarket --verbose`。
5. 如果上游设置页契约变化，同步刷新以下宿主补丁：
   - `patches/@deepseek-ai+dsh-client-ui-settings-plugins+*.patch`
   - `patches/@deepseek-ai+dsh-client-ui-settings+*.patch`
6. 运行 `npm test`、`npm run typecheck`、`npm run package:dir`。运行时 staging 会在补丁应用后移除 `dshmarket/src`，安装包只保留服务端产物与浏览器 bundle。

采用“精确 npm 版本 + 小型补丁”而不是 git submodule 或 `file:../dsh-market`，是为了让 Windows、macOS、Linux 和 GitHub Actions 使用完全相同、可复现的输入；上游升级也只需要显式处理真实冲突。
