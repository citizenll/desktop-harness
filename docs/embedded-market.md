# 内置插件市场维护说明

DSH Desktop 把插件市场视为第一方产品能力，而不是用户需要安装或自行更新的插件。

## 组成

- `packages/dsh-desktop-market`：市场服务、浏览器客户端和商店目录适配。
- `packages/dsh-desktop-plugin-runtime`：固定 Desktop profile 与随应用打包的 pnpm 执行边界。
- `build/dsh-desktop.patch.yml`：先挂载 runtime，再挂载内置市场。
- DSH 设置页补丁：把市场的“发现 / 主题 / 已安装 / 高级”视图投影到默认“插件”页面。

根项目通过 `file:packages/dsh-desktop-market` 使用内置包。正式构建和 CI 不依赖 npm 上的 `dshmarket`，也不依赖 `D:\Dev\self\dsh-market` 相邻仓库。

## 稳定边界

- 市场继续使用 `/dsh-market/*` 路由和当前商店目录数据格式。
- 插件安装、更新和卸载只能调用 `desktopPnpm`，不能寻找系统 pnpm。
- 市场不能更新、卸载或停用自身。
- 市场只把 Cordis 作为运行时 peer，不声明 `@deepseek-ai/dsh-settings` 等 DSH peer dependency。
- DSH 版本变化只允许影响市场入口适配；目录、筛选和安装业务不得依赖 DSH 私有实现。

启动迁移仍会清除旧 profile 中安装过的 `dshmarket` 注册和链接，但不会删除用户通过市场安装的插件，也不会删除市场配置、备份、会话或模型数据。

## 来源与更新

初始代码来源和许可证记录在 `packages/dsh-desktop-market/UPSTREAM.md`。

不跟随 dsh-market 上游版本。确需吸收代码时：

1. 在独立 checkout 中定位需要的上游 commit 和文件；
2. 只移植解决当前需求的源代码，并记录来源 commit；
3. 在隔离环境重建 `lib/` 与 `client/`；
4. 审核生成产物，确认没有恢复市场自更新和 DSH peer dependency；
5. 运行 `npm test`、`npm run typecheck`、`npm run package:dir`。

运行时 staging 会移除内置市场的 `src/`、构建配置与源码映射，安装包只保留服务端产物、浏览器 bundle、许可证和必要元数据。
