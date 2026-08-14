# @deepseek-ai/dsh-source-repository

English | [中文](README.zh.md)

Service Definition for the managed DeepSeek Harness source workspace. `SourceRepository` owns the typed operations and result vocabulary for inspection, first materialization, official fetch and integration, user-remote configuration, and non-force publication. Providers register `ctx.sourceRepository`; consumers do not construct Git commands or inspect repository files directly.

Snapshots distinguish a missing workspace, an occupied non-repository path, and a ready Git working tree. A ready snapshot reports the current commit and branch, clean state, unfinished Git operation, official and user remotes, and fetched ahead/behind counts. Mutation receipts currently state `runtime: "unchanged"`: source operations do not claim to switch the active application runtime.

## Model Experience

None, as this Service Definition registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No provider policy** — executable lookup, repository locking, remote validation, timeouts, and filesystem effects belong to a provider such as [`source-repository-git`](../source-repository-git/README.md).
- **No runtime activation** — the current receipt vocabulary deliberately reports that the active runtime is unchanged until verified generation activation is implemented.
