# Agent Note: GUI Profile 通过 capability seam 管理源码仓库与 Profile 扩展

Status: implemented

[English](2026-08-14-managed-source-and-profile-evolution.md) | 中文

## Problem

Web 与 Desktop 设置界面原本只能检查已挂载的 Cordis 插件树，不能管理组成 profile 的包。打包 Desktop 应用也没有自己负责的源码工作区，因此 Agent 检查或定制完整产品前，用户仍需另行手动 clone。仓库也没有为接收官方变更与发布用户自有定制定义不同权限。

若 Client 直接执行 Git 与包管理器，就会把文件系统路径、可执行文件解析、凭据、超时和进程清理权限暴露给不受信任的 renderer。若把包 mutation 直接加入 Cordis Loader，还会混合已安装依赖状态与 runtime entry 树，并为 profile 组合建立第二条归属路径。

## Decision

GUI profile 挂载两组完整 capability seam。`@deepseek-ai/dsh-source-repository` 定义托管仓库操作，`@deepseek-ai/dsh-source-repository-git` 通过 `ctx.subprocess` 实现这些操作。`@deepseek-ai/dsh-profile-plugins` 定义 profile 依赖操作，`@deepseek-ai/dsh-profile-plugins-pnpm` 使用 provider 固定版本的 pnpm runtime 实现这些操作。`@deepseek-ai/dsh-host-evolution-control` 是同时消费两项服务的唯一 GUI Remote；Client 不构造命令或仓库路径。

托管源码根目录默认为 `$DSH_HOME/source/deepseek-harness`。Desktop 打包会在临时 clone 中根据本次打包的精确快照创建 Git bundle，并把它放在未使用 ASAR 的应用资源旁。提交胶囊前，打包流程会把 staged 胶囊 tree 与当前工作区的 alternate-index tree 对比，并在任何差异出现时中止。初始化通过同级暂存目录 clone 该 bundle，验证胶囊 commit，配置官方 remote，再以原子 rename 把暂存仓库发布到配置根目录。胶囊缺失时可以明确回退到官方网络 clone；根目录已被占用或无效时会失败，但不删除其中内容。

仓库 provider 为 remote 分配不同角色。可配置的 `upstream` 只接收 fetch；可选的 `origin` 由用户明确配置且只接收普通非 force push。集成官方变更要求 clean 的具名分支，且不存在进行中的 merge、rebase、cherry-pick 或 revert。普通 merge 是默认策略，也可选择 fast-forward-only；发生冲突的 merge 会先 abort 再返回失败。与官方仓库相同或包含内嵌 HTTP 凭据的用户 remote 会被拒绝。

Profile provider 只管理当前 profile manifest 声明的依赖。安装自带 bundle layer 保持可见且不可修改。Install 接受单个 npm、Git、tarball 或绝对文件系统 spec，以无 shell 方式运行 pnpm，校验已安装 manifest，并把导出 `dsh.bundle` 的包同步到 `dsh.profile.bundles`。Update 与 remove 会拒绝 profile dependency map 之外的包。Mutation 成功后发布 `profile-plugins/changed`；profile boot 通过根 Include entry 重新加载当前完整 manifest、bundle 集合、lockfile、profile patch 与 home patch。

所有 mutation 都串行执行。每个 Git 与 pnpm child 都有明确的 argv、cwd、environment、timeout、保留输出上限、终止宽限期和由生命周期负责的 drain。Profile 包脚本继续受 pnpm workspace allowlist 管理，不会获得隐式信任。

## Transport 与界面

`evolution` Remote 暴露源码检查、初始化、官方 fetch 与集成、用户 remote 配置与 push，以及 profile list、install、update 和 remove。这些方法属于特权配置面。浏览器 Connection 只允许 loopback same-origin 调用整个 namespace；Desktop 则通过内部 `dsh://app` origin 访问。

插件中心投影两项现有权威状态，而不创建另一套插件格式：profile provider 提供不可变系统 layer 与可变依赖，Loader inventory 提供已配置 runtime entry 与 Fiber phase。源码页显示 missing、invalid 与 ready 状态，并在 Git 事实不满足安全条件时禁用集成或发布。

## Runtime 激活范围

当前实现中的源码操作只更新托管 Git 工作副本。其 receipt 携带 `runtime: 'unchanged'`，界面也明确说明当前 Host 与 Client 仍使用打包构建。在[可演进源码桌面方案](../../proposed/architecture/2026-08-14-live-source-desktop-evolution.md)描述的 generation builder、验证回执、原子激活、回滚与 safe mode 完成前，产品不得把任意 TypeScript 源码变更表述为已生效的应用更新。

Profile 依赖变更使用现有 Cordis 组合生命周期，并返回 `activation: 'host-recomposed'`。Mutation 成功后 Client 会重新加载，使其启动名册反映重组后的 Host 图。该激活声明只适用于 profile 插件，不适用于托管核心源码。

## Verification

真实 Git 仓库测试覆盖胶囊初始化、官方 fetch 与集成、独立用户发布、不安全 remote 拒绝、dirty 工作树拒绝、已占用根目录和暂存初始化回滚。Profile 测试覆盖包分类、精确 pnpm argv 与 environment、bundle 同步、事件驱动重组、update、remove、校验与失败诊断。Gateway、Connection、app-boot 与 Client component 测试覆盖 Remote 委托、loopback admission、profile watcher、管理状态、确认操作和 renderer reload 行为。

## Consequences

安装后的 Desktop 应用包含完整源码，无需单独 clone 即可创建托管检出。官方更新与用户发布具有相互独立且可审计的 Git 权限。Web 与 Desktop 共用同一插件中心、capability service、生成的 Remote 方法和 profile 组合行为。

应用仍需已验证 generation 生命周期，托管核心源码才能替换活跃 runtime。仓库更新会跨应用替换持久保留，因为源码与 profile 状态位于 Harness home 下；但这些更新本身不提供构建隔离、回滚、safe mode 或 Host 进程监督。

## Alternatives considered

- **由 renderer code 执行 Git 与 pnpm** —— 拒绝，因为这会授予 renderer 命令构造、文件系统、environment 与凭据权限。
- **把 Loader entry 当作已安装包数据库** —— 拒绝，因为 runtime 配置不负责依赖解析、lockfile 或包安装。
- **用同一个可写 remote 同时承担官方更新与用户发布** —— 拒绝，因为 fetch 与 push 权限会变得含混，并且仍能表达向官方仓库意外写入。
- **打包时解压一个源码目录** —— 拒绝，因为这种方式不保留 clean Git 状态、共同历史或普通 merge 与 push 行为。
- **在 runtime generation 存在前宣称源码热更新** —— 拒绝，因为 Git merge 成功不能证明依赖可解析、构建成功，或产出的 Host 与 Client 可以启动。
