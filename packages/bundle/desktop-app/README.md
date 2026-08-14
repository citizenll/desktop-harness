# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The Electron profile layer over [`dsh-web-app`](../web-app/README.md). Its [`cordis.patch.yml`](cordis.patch.yml) retains the shared Host and Client plugin roster while disabling the browser-only startup, HTTP server, Web runtime, and client HMR rows. It clears the Connection row's `webRuntime` injection so the Electron main process can dispatch trusted requests through `ctx.connection.fetch()`, and it replaces the bind-dependent directory-picker chooser with the native backend and matching Client surface.

This package does not create a window or register an Electron protocol. [`apps/desktop`](../../../apps/desktop) owns that application lifecycle and serves the built Web shell, boot manifest, client bundles, RPC calls, and SSE downlinks through the secure `dsh://app` protocol without opening a listening port.

## Model Experience

### Desktop surface system prompt

#### What the model sees

The `app:desktop-surface` section at order -98, before request-varying context. It identifies DeepSeek Harness Desktop as the default referent for "this app" and "this window", states what renderer context is not implicit, names the zero-port `dsh://app` carrier, and gives the rebuild-and-restart rule for source changes.

##### Verbatim section

```markdown
You are interacting with the user through the DeepSeek Harness Electron desktop application. When the user refers to "this app", "this window", or "the desktop app" without naming another target, they mean this application. The renderer provides no implicit DOM, route, screenshot, or selected-file context. The desktop application runs the Host and Client plugin graph in one process tree and serves the built Web shell through dsh://app without a listening port. Source changes require rebuilding the affected artifacts and restarting this desktop application before verification. Starting a separate Web server does not update this desktop window.
```

#### Token effect

One fixed system-prompt section is present on every request while this profile layer is mounted.

#### KV Cache effect

Prefix-stable across turns because the section is registered once near the beginning of the system prompt and changes only with the application-surface contract.

### Shell environment URL

#### What the model sees

Shell tools receive `DSH_DESKTOP_URL=dsh://app/`; the value becomes visible when the model inspects or uses the tool environment.

#### Token effect

None until shell output contains the variable or a command uses it in model-visible output.

#### KV Cache effect

No direct prompt effect. Any shell output that exposes the value is appended after the reusable request prefix.

## Known Limitations and Deferred Work

- **Client-plugin hot replacement is disabled** — Desktop loads built client bundles and supports full window reloads; live bundle rebuild notification remains a Web development workflow.
- **Release distribution is not assembled here** — the application can be packaged locally, but code signing, notarization, installers, and update delivery remain distribution-owned.
