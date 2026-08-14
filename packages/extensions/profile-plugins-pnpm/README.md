# @deepseek-ai/dsh-profile-plugins-pnpm

English | [中文](README.zh.md)

Pinned-pnpm provider for [`ctx.profilePlugins`](../profile-plugins/README.md). The provider manages one configured profile below `$DSH_HOME/profiles`, initializes a missing profile, and invokes its own exact pnpm dependency through `ctx.subprocess`; a system pnpm installation and shell command construction are not used. Command execution has an explicit profile working directory, environment, deadline, output cap, termination grace period, serialized mutation queue, and teardown drain.

Install accepts npm, Git, tarball, and absolute filesystem package specs. Relative filesystem specs are rejected at this service edge; launcher callers may anchor them before invocation. After pnpm succeeds, the provider compares profile dependencies, detects installed packages exporting `dsh.bundle.patch`, reconciles those packages into `dsh.profile.bundles`, emits `profile-plugins/changed`, waits for profile recomposition, and returns the refreshed package graph. Update and remove accept only dependency keys already owned by the active profile.

pnpm's dependency build-script policy remains in force. The provider does not enable lifecycle scripts or convert package metadata into execution permission.

## Model Experience

None, as this provider registers no model-facing contribution.

#### KV Cache effect

None; package operations and diagnostics reach only same-process consumers or privileged Remote callers.

## Known Limitations and Deferred Work

- **No catalog resolution** — users supply an explicit package spec; search, signatures, compatibility ranges, and policy are not implemented here.
- **No transactional package-store rollback** — pnpm owns dependency installation. A failed pnpm command leaves its own recoverable diagnostics, while profile-layer reconciliation and Host recomposition run only after success.
- **Renderer roster reload** — Host recomposition completes before return, but a changed Client package roster requires the plugin center to reload the renderer.
