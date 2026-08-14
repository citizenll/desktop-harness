# @deepseek-ai/dsh-source-repository-git

English | [中文](README.zh.md)

Local Git provider for [`ctx.sourceRepository`](../source-repository/README.md). It materializes the configured workspace from a packaged Git bundle or, when allowed and no capsule is available, from the official repository. Initialization clones into a sibling staging directory, verifies the capsule commit, removes the capsule remote, installs the fetch-only official remote, and renames the completed working tree into place so a failed verification leaves the configured root untouched.

The provider serializes every mutation and runs Git through `ctx.subprocess` with an exact argv, explicit working directory, disabled terminal prompting, bounded output, a deadline, and teardown draining. Official update refuses dirty, detached, or in-progress repositories, fetches the configured branch, then performs either `--ff-only` or a normal merge; a conflicted merge is aborted before failure returns. User publication requires a separate non-official remote, a clean named branch, and a normal `git push --set-upstream`; this package never force-pushes.

Remote display values redact embedded URL credentials, while configuration rejects embedded HTTP credentials and any user remote whose normalized repository identity equals the official repository. Authentication remains owned by Git Credential Manager, an SSH agent, or another Git credential provider.

## Model Experience

None, as this provider registers no model-facing contribution.

#### KV Cache effect

None; repository state and diagnostics reach only same-process consumers or privileged Remote callers.

## Known Limitations and Deferred Work

- **Source state only** — successful mutations return `runtime: "unchanged"`; they do not build or activate a new runtime generation.
- **One configured official branch** — branch discovery, pull-request workflows, conflict resolution, and history rewriting are outside this provider.
- **Git-owned authentication** — the provider does not store credentials or open interactive terminal prompts.
