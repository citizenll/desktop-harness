# @deepseek-ai/dsh-profile-plugins

English | [中文](README.zh.md)

Service Definition for profile-installed Harness extensions. `ProfilePlugins` owns list, install, update, and remove operations over one active profile, while providers own package-manager execution and manifest effects. Entries distinguish installation-owned system bundles, user-managed extension bundles that contribute a `dsh.bundle` patch, and installed libraries that do not contribute a profile layer.

A successful mutation returns the complete profile snapshot only after the provider emits `profile-plugins/changed` and every listener has completed Host recomposition. The receipt therefore reports `activation: "host-recomposed"`; Client rosters may still require a renderer reload before a newly installed Client half appears.

## Model Experience

None, as this Service Definition registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No catalog metadata** — publisher identity, signatures, compatibility, reviews, pricing, and organization policy belong to future catalog providers.
- **Profile scope only** — installation-owned bundles remain immutable, and Electron or native-kernel replacement is not a profile package operation.
