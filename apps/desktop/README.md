# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The Electron application reuses the built Web shell and the same Cordis Host/Client plugin graph as the browser product. It boots the `desktop` profile in the main process, exposes static assets, the client boot manifest, plugin bundles, RPC requests, and SSE downlinks through the privileged `dsh://app` custom protocol, and opens no HTTP listener.

The desktop profile layers [`dsh-base`](../../packages/bundle/base/README.md), [`dsh-web-app`](../../packages/bundle/web-app/README.md), and [`dsh-desktop-app`](../../packages/bundle/desktop-app/README.md). The last layer removes the browser-only startup, Web server, Web runtime, and Client HMR rows, then selects the native directory picker. The renderer therefore keeps the complete shared conversation, trajectory, settings, credentials, agent-preset, terminal, and tool UI without maintaining a forked frontend.

## Development

Run these commands from the repository root:

```sh
pnpm run desktop
pnpm run desktop:built
pnpm run package:desktop
```

`desktop` builds every required artifact before launching Electron, `desktop:built` launches the existing build, and `package:desktop` builds and packages the current platform.

Packaged output is written under `.artifacts/desktop/DeepSeekHarness-<platform>-<arch>` by default. Set `DSH_DESKTOP_PACKAGE_OUTPUT` to an alternate output root when validating a replacement while another packaged build is running. The package step creates a production-only, hoisted deployment of the workspace closure before invoking Electron Packager; it keeps files outside ASAR because profile packages, dynamic plugin resolution, and native helpers require ordinary filesystem paths. Windows executables embed the multi-resolution icon generated from [`assets/icon.png`](assets/icon.png).

Each packaged application also carries a Git source capsule produced from the exact packaging snapshot, including uncommitted and untracked files captured through a temporary clone. Before committing the capsule, packaging compares its staged Git tree with an alternate-index tree of the current workspace and aborts on any missing, extra, or different file. The Source settings tab can materialize that capsule as a clean repository under `$DSH_HOME/source/deepseek-harness`; a machine therefore does not need a separate manual clone before the user or agent begins customization.

The executable accepts `--profile <name>`, repeated `--patch <file>`, and `--devtools`. The internal `--smoke-test` flag opens a hidden renderer, verifies the boot manifest, loaded Client module graph, rendered application root, and real same-origin RPC calls for dotted methods such as `llm.providers` and `agentPreset.list`, then exits with a status suitable for build verification.

## Security and lifecycle

The renderer uses Chromium sandboxing and context isolation with Node integration, preload bridges, and `<webview>` disabled. Its Content Security Policy blocks inline and remote scripts while allowing same-origin files and `unsafe-eval`, which the Cordis client loader and dynamic Client plugins require to compile trusted Host-supplied closures at runtime. Fetch, RPC, and stream connections remain same-origin; images may use data, blob, HTTP, or HTTPS sources. Every permission request is denied, navigation stays inside `dsh://app`, and HTTP or HTTPS links open through the operating system. Ordinary launches use one application instance while the menu can create multiple windows over the same Host graph. Closing the application drains the shared profile shutdown controller before Electron exits.

## Known Limitations and Deferred Work

- **Client bundle HMR is disabled** — rebuild the affected artifacts and reload or restart the application.
- **Managed source is not yet an active runtime generation** — initialize, fetch, merge, and push operate on the source workspace, while the running Host and Client remain on the packaged build. Verified generation build, atomic activation, rollback, and safe mode must land before arbitrary TypeScript source changes are presented as an application update.
- **Release plumbing is distribution-owned** — code signing, notarization, platform installers, and automatic updates are not configured by this repository.
- **Packaging is platform-local** — each target is produced on its own operating system; cross-platform release automation is not included.
