# Agent Note: Electron desktop uses the shared GUI graph over a zero-port custom protocol

Status: implemented

English | [中文](2026-08-14-electron-desktop-custom-protocol.zh.md)

## Problem

The shipped GUI exists as a browser application whose composition assumes an HTTP server, browser startup arguments, WebSocket downlinks, and Web-only development HMR. A desktop application must preserve the complete plugin-driven Host and Client experience without maintaining a second frontend, exposing a localhost service, or granting renderer code Node or Electron privileges.

The same profile mechanism must remain authoritative for built-in bundles, user plugins, machine-local patches, settings, credentials, sessions, and tools. Electron also changes two runtime facts: its main process does not expose Cordis Loader's internal ESM loader, and native helpers spawned through `process.execPath` would otherwise start another Electron application instead of a plain Node worker.

## Decision

`apps/desktop` is an Electron main-process application that boots the shared `@deepseek-ai/dsh/profile-boot` launcher with the built-in `desktop` profile. The profile layers `dsh-base`, `dsh-web-app`, and `dsh-desktop-app`, so the desktop application inherits the complete GUI roster and changes only application-specific carrier and interaction rows.

The Electron main process registers `dsh` as a privileged standard and secure scheme, then serves one canonical origin, `dsh://app/`. Its protocol handler provides the built Vite shell, an external boot-manifest script, client plugin bundles and source maps, transport-independent Host RPC dispatch, and SSE downlinks. `/api` routing takes precedence over static filename classification because Typert API method names such as `llm.providers` contain periods. The application opens no HTTP listener and mounts neither `dsh-host-webserver` nor the browser WebSocket adapter.

## Carrier and profile composition

`dsh-client-modules` always owns the boot graph and `clientPath(id)` registry. Its `/plugins` routes and index transformation are optional adapters activated only when `ctx.webServer` exists; the desktop protocol reads the same registry directly. `dsh-client-connection` likewise always owns `ctx.connection.fetch(request)` and the RPC handler registry, while its `/api` route and WebSocket upgrades are optional Web adapters. The renderer selects `EmbeddedApiClient`, which uses `globalThis.fetch` against `dsh://app` and the existing fetch/SSE codec for both downlink streams.

`dsh-desktop-app` disables the Web startup, Web server, Web runtime, Client HMR, and bind-dependent directory-picker chooser rows. It clears the Connection row's Web-only injection, pins the native directory picker and matching Client surface, adds model-visible orientation for the Electron application, and exposes `DSH_DESKTOP_URL=dsh://app/` through the shell environment. The desktop shell does not fork or special-case the conversation, trajectory, terminal, settings, credentials, agent-preset, or tool interfaces.

## Security and lifecycle

Renderer windows enable Chromium sandboxing and context isolation and disable Node integration, preload bridges, `<webview>`, insecure content, and cross-origin navigation. The custom-protocol index receives a Content Security Policy that blocks inline and remote scripts but permits same-origin files and `unsafe-eval`; the Cordis client loader and dynamic Client plugins require runtime evaluation for trusted Host-supplied closures. Fetch, RPC, and stream connections remain same-origin, while image rendering may use data, blob, HTTP, or HTTPS sources. All Chromium permission checks and requests are denied, new HTTP or HTTPS links are delegated to the operating system, and other navigations are blocked. Normal launches use Electron's single-instance lock, while the application menu can create multiple windows over one Host graph.

Application shutdown is routed through the shared profile shutdown controller before Electron exits. Renderer crashes are diagnosed without granting recovery privileges to renderer code. The desktop profile keeps user patch files live: Cordis HMR owns the exact-file watch when available, and embedded runtimes use the same serialized refresh and `hmr/config-update-failed` behavior through a portable polling watcher.

## Module resolution and packaging

`mountRootInclude` uses Cordis Loader's internal module loader when it exists. When Electron does not expose that loader, the installed application supplies `bareModuleBaseUrl`; app boot resolves bare package names through `createRequire(base).resolve()` and imports the resulting file URL, while relative names remain configuration-relative.

The packaging command builds all artifacts, creates a production-only deployment with pnpm workspace injection and a hoisted node_modules layout, then runs Electron Packager at the exact Electron version declared by the application. The desktop manifest explicitly lists the Service Definition packages required to satisfy plugin peer dependencies in that deployed closure. The output remains unpacked instead of using ASAR because profiles, dynamic package resolution, and native helpers require ordinary filesystem paths. On Windows, the native directory dialog adds `ELECTRON_RUN_AS_NODE=1` only to its worker child so `process.execPath` runs the bundled Node entry without changing the main application environment.

## Verification

Focused tests cover desktop argument parsing, protocol routing and path confinement, profile composition, model and shell contributions, transport-independent Connection and module adapters, portable patch watching, host module-resolution fallback, and the Electron-specific native-dialog child environment. A hidden source smoke opens the renderer and checks the boot manifest, loaded Client module graph, rendered application root, and correlated server envelopes from real renderer POST requests to dotted API methods. A packaged Windows executable repeats the smoke from a fresh Harness home and exits successfully.

## Alternatives considered

- **A localhost HTTP server inside Electron** — rejected because it retains port allocation, Host-header and browser-network exposure, and WebSocket lifecycle work that an embedded same-process application does not need.
- **`file://` plus a preload IPC bridge** — rejected because `file://` has awkward origin semantics and a preload bridge creates a second privileged API surface that must duplicate fetch, streaming, validation, and cancellation behavior.
- **A separate desktop frontend** — rejected because it would fork the plugin roster, module loader, UI behavior, source maps, and product tests from the Web application.
- **Packaging into ASAR** — rejected because ordinary filesystem paths are part of profile, package-resolution, source-map, and native-helper operation.

## Consequences

Desktop and Web now share one GUI plugin graph, one boot manifest format, one RPC protocol, and one built frontend. Desktop has no listening port and its renderer receives no Node or Electron authority. New GUI plugins appear on both surfaces through the existing composition mechanism unless a profile layer deliberately changes them.

Desktop client-plugin HMR remains disabled, so source and bundle changes require rebuilding and reloading or restarting the application. The repository produces a platform-local unpacked application directory; code signing, notarization, installers, update delivery, and cross-platform release orchestration remain distribution responsibilities.
