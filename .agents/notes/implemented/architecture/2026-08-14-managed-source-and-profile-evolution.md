# Agent Note: GUI profiles manage source repositories and profile extensions through capability seams

Status: implemented

English | [中文](2026-08-14-managed-source-and-profile-evolution.zh.md)

## Problem

The Web and Desktop settings surfaces could inspect the mounted Cordis plugin tree but could not manage the packages that compose a profile. A packaged Desktop application also had no owned source workspace, so a user needed a separate manual clone before the agent could inspect or customize the complete product. The repository did not define distinct authority for receiving official changes and publishing user-owned customization.

Direct Git and package-manager execution in the Client would expose filesystem paths, executable lookup, credentials, timeouts, and process cleanup to untrusted renderer code. Adding package mutation directly to Cordis Loader would also mix installed dependency state with the runtime entry tree and create a second ownership path for profile composition.

## Decision

GUI profiles mount two complete capability seams. `@deepseek-ai/dsh-source-repository` defines managed repository operations and `@deepseek-ai/dsh-source-repository-git` implements them over `ctx.subprocess`. `@deepseek-ai/dsh-profile-plugins` defines profile dependency operations and `@deepseek-ai/dsh-profile-plugins-pnpm` implements them with the provider's pinned pnpm runtime. `@deepseek-ai/dsh-host-evolution-control` is the only GUI Remote consumer of both services; the Client constructs neither commands nor repository paths.

The managed source root defaults to `$DSH_HOME/source/deepseek-harness`. Desktop packaging creates a Git bundle from the exact packaging snapshot in a temporary clone and places it beside the unpacked application resources. Before committing the capsule, packaging compares the staged capsule tree with an alternate-index tree of the current workspace and aborts on any mismatch. Initialization clones the bundle through a sibling staging directory, verifies the capsule commit, configures the official remote, and atomically renames the staged repository into the configured root. A missing capsule can fall back to an explicit official network clone; an occupied or invalid root fails without deleting its contents.

The repository provider assigns separate remote roles. The configurable `upstream` remote receives fetches only, while the optional `origin` remote is configured explicitly and receives ordinary non-force pushes only. Official integration requires a clean named branch with no merge, rebase, cherry-pick, or revert in progress. Normal merge is the default, fast-forward-only is available, and a conflicted merge is aborted before the operation fails. User remotes matching the official repository or containing embedded HTTP credentials are rejected.

The profile provider manages only dependencies declared in the active profile manifest. Installation-owned bundle layers remain visible and immutable. Install accepts one npm, Git, tarball, or absolute filesystem spec, runs pnpm without a shell, validates the installed manifest, and reconciles packages exporting `dsh.bundle` into `dsh.profile.bundles`. Update and remove reject packages outside the profile dependency map. Successful mutations publish `profile-plugins/changed`; profile boot reloads the complete current manifest, bundle set, lockfile, profile patch, and home patch through the root Include entry.

All mutations are serialized. Every Git and pnpm child has explicit argv, cwd, environment, timeout, retained-output limit, termination grace, and lifecycle-owned drain. Profile package scripts remain governed by pnpm's workspace allowlist instead of receiving implicit trust.

## Transport and interface

The `evolution` Remote exposes source inspection, initialization, official fetch and integration, user-remote configuration and push, plus profile list, install, update, and remove. These methods are privileged configuration-plane operations. The browser Connection admits the complete namespace only from loopback same-origin; Desktop reaches it through the internal `dsh://app` origin.

The plugin center projects two existing authorities instead of creating another plugin format: the profile provider supplies immutable system layers and mutable dependencies, while the Loader inventory supplies configured runtime entries and Fiber phases. The source tab reports missing, invalid, and ready states and disables integration or publication when Git facts make the operation unsafe.

## Runtime activation scope

Source operations in this implementation update the managed Git working copy only. Their receipts carry `runtime: 'unchanged'`, and the interface states that the current Host and Client remain on the packaged build. Arbitrary TypeScript source changes must not be presented as an active application update until the generation builder, verification receipt, atomic activation, rollback, and safe mode described by the [live-source desktop evolution proposal](../../proposed/architecture/2026-08-14-live-source-desktop-evolution.md) are implemented.

Profile dependency changes use the existing Cordis composition lifecycle and return `activation: 'host-recomposed'`. The Client reloads after successful mutation so its boot roster reflects the recomposed Host graph. This activation claim applies to profile plugins, not to managed core source.

## Verification

Real Git repository tests cover capsule initialization, official fetch and integration, separate user publication, unsafe remote rejection, dirty-tree refusal, occupied roots, and staged-initialization rollback. Profile tests cover package classification, exact pnpm argv and environment, bundle reconciliation, event-driven recomposition, update, remove, validation, and failure diagnostics. Gateway, Connection, app-boot, and Client component tests cover Remote delegation, loopback admission, profile watchers, management states, confirmations, and renderer reload behavior.

## Consequences

An installed Desktop application contains complete source and can create its managed checkout without a separate clone. Official updates and user publication have independent, auditable Git authority. Web and Desktop share the same plugin center, capability services, generated Remote methods, and profile composition behavior.

The application still needs a verified generation lifecycle before managed core source can replace the active runtime. Repository updates remain durable across application replacement because source and profile state live under the Harness home, but they do not by themselves provide build isolation, rollback, safe mode, or Host process supervision.

## Alternatives considered

- **Execute Git and pnpm from renderer code** — rejected because it would grant the renderer command construction, filesystem, environment, and credential authority.
- **Treat Loader entries as the installed package database** — rejected because runtime configuration does not own dependency resolution, lockfiles, or package installation.
- **Use one writable remote for both official updates and user publication** — rejected because fetch and push authority would be ambiguous and accidental writes to the official repository would remain representable.
- **Extract a source directory during packaging** — rejected because it would not preserve clean Git state, common history, or ordinary merge and push behavior.
- **Claim source hot update before runtime generations exist** — rejected because a successful Git merge does not prove that dependencies resolve, the build succeeds, or the resulting Host and Client can start.
