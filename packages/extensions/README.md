# extensions/ — runtime extension and managed evolution

English | [中文](README.zh.md)

Extension mechanisms over the live Cordis runtime and the installed product profile: model-written dynamic packages, managed profile dependencies, and the local source repository used for official updates and user-owned publication. The dynamic runner's browser-half packages remain here rather than under `packages/client/` because they are halves of this subsystem's dual-half packages; the host aggregate excludes them so each face keeps its own compiler program. Design homes: [the dynamic toolset Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) and [the desktop evolution specification](../../.agents/notes/proposed/architecture/2026-08-14-live-source-desktop-evolution.md).

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | Model-facing runtime inspection and dynamic-package tools | registers on `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.md) | Definition registry, the `node:vm` sandbox for host halves, and the request-run round trip | provides `ctx.dynamicCordisRunner` |
| [`cordis-client-runner/`](cordis-client-runner/README.md) | Browser half of a dual-half package: evaluates the definition into a live browser plugin and answers the run request | client face; provides the browser `ctx.dynamicCordisRunner` |
| [`ui-cordis/`](ui-cordis/README.md) | Browser surfaces: the frame-wide panel that operates every definition, and the read-only define card | client face; registers slots |
| [`source-repository/`](source-repository/README.md) | Managed Harness source Service Definition | `ctx.sourceRepository` |
| [`source-repository-git/`](source-repository-git/README.md) | Local Git provider for capsule initialization, official update, and user publication | provides `ctx.sourceRepository` |
| [`profile-plugins/`](profile-plugins/README.md) | Active-profile package-management Service Definition | `ctx.profilePlugins` |
| [`profile-plugins-pnpm/`](profile-plugins-pnpm/README.md) | Bundled-pnpm provider and `dsh.bundle` reconciliation | provides `ctx.profilePlugins` |
