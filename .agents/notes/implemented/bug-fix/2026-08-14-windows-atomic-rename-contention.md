# Agent Note: Windows atomic replacement retries transient path contention

Status: implemented

English | [中文](2026-08-14-windows-atomic-rename-contention.zh.md)

## Problem

`dsh-atomic-write` published a staged file with one `rename(temp, target)` attempt. On Windows, an existing target can be held briefly by a reader, indexer, or security scanner, and libuv reports the replacement as `EACCES`, `EPERM`, or `EBUSY`. The settings browser scenario exposed the failure by reading `settings.yaml` while a theme preference was committing: the settings RPC returned `settings-rejected`, the staged file was correctly removed, and the old document remained, so an apparently selected theme was lost on reload. This is not a test-only race; every shared settings, credentials, or authored-preset document can meet an unrelated same-user reader.

## Decision

`writeFileAtomic` owns bounded retry around only the publication rename. On Windows, `EACCES`, `EPERM`, and `EBUSY` keep the same staged file and target intact while retrying with backoff from 10 ms to 100 ms for at most 2 seconds. Every other error, and every rename error on another platform, propagates immediately. When the deadline expires, the last operating-system error propagates and the existing outer cleanup removes the staged file.

The retry remains inside `withFileLock` when callers use the cross-process writer protocol, so another conforming writer cannot render against the old target while publication is waiting. The timeout and backoff are protocol invariants rather than deployment settings: they absorb short sharing conflicts without turning a persistent permission failure into an unbounded write.

## Alternatives considered

- **Serialize the browser test's reads.** Rejected because it would hide the same sharing conflict from antivirus scanners, indexers, editors, and other local readers without making the product more reliable.
- **Delete the target before renaming, or fall back to copying the staged content.** Rejected because either path creates a missing or partially written interval and gives up the primitive's central atomic-replacement guarantee; a crash between deletion and rename could also lose the last good document.
- **Retry the provider's complete read-render-write operation.** Rejected because the staged content is already valid and protected by the writer lock. Re-reading can admit a different document generation and repeats parsing and rendering that did not fail; the contention belongs to publication.
- **Move the Koffi `ReplaceFileW` path from `dsh-fs-local` into the zero-dependency utility.** Rejected for this defect: that path exists to preserve a target DACL and other replacement metadata, while the shared Harness-home stores need a short sharing-conflict recovery. Pulling a native dependency into every settings and credentials installation is a separate Windows permission decision.

## Consequences

Short-lived Windows sharing conflicts no longer discard settings, credential, or preset-authoring writes. A persistent Windows conflict may now take up to 2 seconds longer to fail, after which callers receive the original error code and message; POSIX timing is unchanged. Unit coverage injects all three retryable codes, proves non-Windows failures do not retry, and advances a persistent conflict through the deadline while checking that the old target survives and no temp remains. The browser theme scenario exercises the real settings provider while repeatedly reading the target during publication.
