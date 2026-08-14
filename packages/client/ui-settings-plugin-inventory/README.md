# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

Browser Settings surface for profile extensions and managed Harness source. The plugin registers two lazy `settings.plugins.tab` contributions: **Plugin center** (`center`) and **Source & updates** (`source`). Activation performs no Remote reads; each component requests its current state only when the Plugins section mounts that tab. Both registrations use `ctx.slots.inject()`, so they follow late declaration, redeclaration, locale changes, and teardown without importing the section owner.

The plugin center combines two existing authorities. `evolution/pluginsList` supplies installation-owned system bundles, mutable profile extension bundles, and installed libraries; `pluginInventory/list` supplies the current Cordis Loader entries and Fiber phases. Users may install an explicit npm, Git, tarball, or absolute filesystem package spec, update or remove mutable dependencies, and confirm removal before it executes. A successful package mutation has already recomposed the Host; the tab reloads the renderer so a changed Client roster is discovered. Load failures remain generic, while explicit mutation failures preserve the provider diagnostic needed to fix the package or repository input.

The source tab shows missing, invalid, and ready repository states. It can initialize the packaged source capsule, fetch the official branch, integrate it by fast-forward-only or normal merge, configure a separate user-owned remote, and perform a normal non-force push. Dirty, detached, or in-progress repositories disable integration and publication controls. The interface states that successful source operations update the working copy only and do not yet switch the active runtime.

## Model Experience

None, as this package only presents privileged Host configuration in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Explicit package specs only** — signed catalogs, publisher metadata, compatibility ranges, organization policy, reviews, and pricing are future catalog-provider work.
- **Point-in-time Loader inventory** — the runtime list refreshes when Settings remounts or the client reloads; it does not subscribe to every Fiber transition.
- **Source activation is deferred** — fetch, merge, and push are implemented, but verified generation build, atomic activation, rollback, and safe mode are not yet exposed by this Client package.
