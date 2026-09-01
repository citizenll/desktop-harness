# DSH Desktop Verifier

Status: implementation contract

## Decision

DSH Desktop ships a first-party, session-scoped **Verifier** mode. When enabled, each ordinary agent-loop model step is generated three times with the session's selected model. A fixed Probabilistic Pivot Tournament then asks a separately configured verifier model to rank the three complete candidate responses. Only the winning response is replayed into the agent loop; losing tool calls are never executed.

The implementation is a Desktop-owned DSH plugin, `dsh-desktop-verifier`. It uses DSH's public LLM waterfall, command lifecycle, session projection, credential, settings, slot, and web-server seams. It does not patch DSH behavior and does not run the upstream Python package.

## Problem

A single stochastic model response can make an avoidable reasoning or tool-selection error. The requested feature is not another chat assistant or a post-hoc critique: it must improve the response that the existing DSH loop consumes while preserving the loop's authority over tools, history, cancellation, and accounting.

## Goals

- Let the user enable or disable verification for one session from the conversation composer.
- Persist that choice in the existing session log and restore it after restart or fork replay.
- Generate three candidates through the current DSH model route and select one before the loop observes any output.
- Implement the fine-grained logprob reward and Probabilistic Pivot Tournament from `llm-as-a-verifier` in native TypeScript.
- Show honest candidate, scoring, and replay timing plus verifier call cost without changing DSH's canonical winner usage.
- Fail explicitly when the configured verifier cannot perform the required scoring.

## Non-goals

- Full independent agent trajectories. V1 ranks one model step at a time.
- Executing, sandboxing, or simulating losing candidates' tool calls.
- Python, a sidecar process, or a proxy in front of every provider.
- Automatic fallback to one candidate, literal-label scoring, a smaller tournament, another verifier model, or unverified output.
- User-tunable candidate count, pivot count, repeat count, criteria, seed, or algorithm.
- Image-bearing requests. V1 cannot give the verifier the same durable image evidence, so it rejects them before candidate generation.
- Changing DSH core event types, agent-loop semantics, context accounting, or provider adapters.

## Fixed semantics

The mode is deliberately not a collection of knobs:

- candidates: `N = 3`
- pivots: `k = 1`
- verifier evaluations per directed pair: `K = 1`
- ring seed: `0`
- criterion: `Task Success`
- ring: one deterministic Hamiltonian cycle
- comparisons: three ring pairs plus two non-pivot-versus-pivot pairs, five verifier requests total
- selection: mean Bradley-Terry soft-win mass, ties resolved by the lowest candidate index

This is eight model requests per verified step: three candidate requests and five verifier requests. `K = 1` is intentional for an interactive desktop path; the Hamiltonian ring still places every candidate once in slot A and once in slot B, while repeated pair evaluations would double latency and cost.

## Request flow

1. The LLM waterfall receives an ordinary agent-loop request.
2. The plugin bypasses the request unless all of these are true:
   - DSH marks it as an agent-loop request;
   - `purpose` is absent;
   - the current DSH initiator exists;
   - the request `sessionId` equals that initiator's session id;
   - the session's folded `/verify` state is active;
   - this is not one of the plugin's own candidate requests.
3. The plugin rejects the request if any message contains an image block.
4. It resolves and validates the verifier connection, including the credential, before spending any candidate requests.
5. It clones the exact request three times and dispatches the clones concurrently through `ctx.llm.stream`. The clones are identity-marked in a `WeakSet`, so they traverse the normal middleware and provider route once but bypass this plugin's tournament recursively.
6. Each complete stream is buffered. The plugin records each candidate request's start, first real token, completion, and usage independently. A candidate is valid only when it has a terminal successful finish. `error`, `aborted`, missing finish, or empty content fails the entire verified step.
7. The plugin serializes the exact model-visible task context and each complete candidate trace.
8. It sends five direct OpenAI-compatible chat-completions requests with `logprobs=true` and `top_logprobs=20`, recording request start, response arrival, completion, pair, stage, and usage for every comparison.
9. It extracts the A-T probability distribution at both score tags. Absence of either usable distribution fails the step; the literal emitted letter is not a substitute.
10. It runs the fixed tournament and replays the winning candidate's original chunks unchanged. Replay has its own start, first-token, and completion timestamps and is never reported as model generation speed.

The agent loop therefore sees exactly one normal response and executes only that response's tool calls.

## Scoring contract

The TypeScript port is based on `llm-as-a-verifier` commit `8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770` (MIT). Attribution is retained in the package.

The score scale is A through T, mapped to 20 through 1. For each tag, the reward is the normalized expected value over valid top-logprob alternatives:

`R = (E[value] - 1) / 19`

Each directed pair yields `(R_A, R_B)`. The tournament converts it to a soft preference:

`p(A > B) = sigmoid(R_A - R_B)`

The single criterion is:

> How likely the agent correctly and completely solved the task. Strongest signal is verification against task-specific requirements; length or confidence alone do not imply correctness.

The prompt contains the system prompt, all request messages, tool schemas, and both candidate traces without silent truncation. Candidate traces retain text, reasoning, tool names, call ids, raw arguments, and nested tool results.

## Verifier connection

The plugin owns settings namespace `dsh-desktop-verifier`:

| Field | Default | Meaning |
| --- | --- | --- |
| `verifierModel` | `deepseek-v4-flash` | OpenAI-compatible verifier model id |
| `baseURL` | `https://api.deepseek.com` | API root; `/chat/completions` is appended |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DSH credential reference, never a plaintext setting |
| `reasoningEffort` | `high` | `off`, `low`, `high`, or `max` |
| `maxTokens` | `32768` | verifier reasoning plus verdict output budget |

Every scoring operation resolves `apiKeyEnv` through `ctx.credentials`. A missing credential is `VERIFIER_CREDENTIAL_MISSING`. No ambient or secondary credential is guessed.

The request uses temperature 1, top-20 token logprobs, and the configured reasoning controls. Non-2xx responses, malformed JSON, absent choices, absent answer logprobs, and absent score distributions are explicit failures. There are no retries or fallback routes in this plugin.

## Session state

No custom session event is introduced. The `/verify on` and `/verify off` command uses DSH's durable `command/run` and `command/done` lifecycle.

- Only the exact arguments `on` and `off` are accepted.
- A successful matching `command/done` commits the requested state.
- A failed command does not change state.
- The empty log is off.

The `verifier` session projection exposes `{ active, pending }`. The host interceptor and the client projection use the same pure fold semantics.

## UI

- `conversation.input.right`: one compact `Verifier` toggle next to send. It reflects the host projection, has `aria-pressed`, disables while its command is pending, and never applies optimistic state.
- `conversation.input.dock`: one compact progress row while verifier mode is active and a run has state to show.
- Progress is read from `/dsh-desktop-verifier/state?sessionId=...` only while the effective mode is active.
- The endpoint returns status, counts, winner index, error code/message, candidate/verifier token totals, phase timestamps, and per-request timing/usage. It never returns prompts, candidate text, reasoning, tool arguments, or credentials.
- Every terminal run writes the same content-free timing/usage snapshot to the named host logger, so completed and failed runs remain diagnosable from the Desktop Harness log after the in-memory progress state is gone.
- Status stages are `generating`, `scoring-ring`, `scoring-pivots`, `replaying`, `complete`, `error`, and `cancelled`.
- The progress row derives candidate TTFT and throughput from the three actual candidate streams. It separately shows candidate wall time, scoring wall time, replay time, and end-to-end time.
- DSH's generic session TTFT and throughput observe the buffered winner replay because the agent loop must not see a losing candidate. The Verifier row states this explicitly instead of presenting replay throughput as provider throughput.

## Cancellation and failure

The original request signal is shared with all candidate and verifier calls. The first failure aborts remaining work. If the caller aborts, the plugin reports `cancelled` and yields no partial candidate. Any other failure reports `error` and terminates the stream with one DSH `finish` chunk carrying the stable verifier failure code.

The plugin does not silently call `next()` after a verified run has begun. Turning the mode on means the step is verified or it fails visibly.

## Usage accounting

The winner's original stream, including its original `usage` chunk, is replayed unchanged. This preserves DSH's context-pressure and compaction calculations.

Candidate and verifier usage is accumulated separately in the progress state and shown as additional Verifier cost. It is not merged into the winner's canonical usage because those extra calls are not conversation context.

If a provider omits usage, the corresponding completeness flag is false; the plugin does not invent token counts.

The generic session token line remains the canonical conversation-context usage of the winner. The Verifier progress state is the authoritative source for the total eight-call verifier usage and the actual candidate/scorer latency. These two accounting domains are intentionally not merged.

## Packaging and update boundary

- Source and build output live in `packages/dsh-desktop-verifier`.
- The root manifest consumes it through `file:packages/dsh-desktop-verifier`.
- The private package declares no DSH peers; the governed root release train owns the one exact DSH graph, avoiding npm peer resolution silently selecting a newer prerelease.
- Desktop composition inserts it as a first-party host/client plugin.
- Core staging, patchset hashing, required-file verification, and release CI include its host and client artifacts.
- The existing DSH manifest-resolution patch declares the package; no new behavioral DSH patch is added.
- Future DSH upgrades can replace or merge core packages independently; this Desktop-owned plugin remains behind public seams.

## Acceptance criteria

1. `/verify on`, `/verify off`, failed syntax, replay, and projection pending state have unit tests.
2. Ring construction, pivot selection, Bradley-Terry aggregation, deterministic ties, and exact five-comparison BO3 behavior have unit tests.
3. Logprob extraction rejects missing A-T distributions and computes normalized expectations correctly.
4. Candidate buffering rejects failed/incomplete streams and preserves the winning chunks byte-for-byte at the object level.
5. Only bypass-marked nested candidate requests avoid the interceptor; ordinary other-session and auxiliary calls remain untouched.
6. Image-bearing verified requests fail before any candidate request.
7. Credential, HTTP, malformed-response, cancellation, and no-score failures expose stable codes and never fall back.
8. The client bundle registers exactly the two specified conversation slots and contains no candidate content surface.
9. Candidate timing records the first non-empty model delta once; every comparison records its request/response boundary; replay is a distinct status and phase.
10. The UI never labels replay TTFT or replay throughput as model performance and exposes the actual candidate metrics after completion.
11. Host typecheck, marketplace client typecheck, verifier host/client typecheck, verifier build, release-train checks, and the full repository test suite pass.
12. Core staging and packaged-runtime verification require both `dsh-desktop-verifier/lib/index.js` and `dsh-desktop-verifier/client/client.js`.
