# @deepseek-ai/dsh-host-evolution-control

English | [中文](README.zh.md)

Privileged Host Remote gateway for managed source and profile extensions. `EvolutionControlGateway` consumes `ctx.sourceRepository` and `ctx.profilePlugins`, then publishes generated direct methods under the `evolution` namespace for source inspection, initialization, official fetch and update, user-remote configuration and push, plus plugin list, install, update, and remove.

The gateway contains no Git, package-manager, filesystem, or command construction. It forwards typed inputs and provider receipts unchanged, so the Service Providers remain the only authorities for mutation serialization, validation, timeouts, and diagnostics. [`api-remotes`](../../api/remotes/README.md) explicitly selects its generated Client contribution, and [`client/connection`](../../client/connection/README.md) classifies every `evolution.*` method as privileged so the browser carrier admits it only from loopback while Electron uses its internal `dsh://app` origin.

## Model Experience

None, as this Host configuration gateway registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; the gateway is reachable only through explicit Client Remote calls.

## Known Limitations and Deferred Work

- **Transport admission is not user authentication** — a remotely exposed multi-user deployment requires an authenticated authority layer before enabling this namespace.
- **Provider results are authoritative** — the gateway does not add progress persistence, audit history, catalog metadata, or runtime generation activation.
