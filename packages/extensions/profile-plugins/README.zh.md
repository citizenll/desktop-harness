# @deepseek-ai/dsh-profile-plugins

[English](README.md) | 中文

profile 安装的 Harness 扩展所用的 Service Definition。`ProfilePlugins` 拥有针对一个活跃 profile 的列表、安装、更新与移除操作，Provider 则拥有包管理器执行与 manifest 效果。条目区分安装所拥有的系统 bundle、贡献 `dsh.bundle` patch 的用户可管理扩展 bundle，以及不贡献 profile 层的已安装库。

成功修改只在 Provider 发出 `profile-plugins/changed` 且所有监听器完成 Host 重新组合后，才返回完整 profile 快照。因此回执报告 `activation: "host-recomposed"`；在新安装的 Client half 出现前，Client 名册仍可能需要刷新 renderer。

## 模型体验

无，因为该 Service Definition 不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **不包含目录元数据** —— 发布者身份、签名、兼容性、评论、价格与组织策略属于未来的目录 Provider。
- **仅限 profile 范围** —— 安装所拥有的 bundle 保持不可修改，Electron 或原生内核替换不是 profile 包操作。
