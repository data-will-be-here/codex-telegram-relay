# Subagent approvals missing from the parent topic

Date: 2026-11-05. The diagnosis below led to a correction on `dev`, verified with synthetic integration tests. No real approval decision or model input was sent during diagnosis or testing. The separate first-message readiness correction is committed as `640219a`.

## Findings

The screenshot names an Agent thread. Read-only native metadata established a performance-audit child with a direct parent thread that already has a saved Telegram topic. The child's `source.subAgent.thread_spawn.parent_thread_id` and top-level `parentThreadId` agree; `canAcceptDirectInput` is false. The command fragment from the screenshot also occurs in that child's journal. Full session IDs, conversation text and local project paths are omitted here. Two loaded children share the same eight-character prefix, so the full ID and ancestry are necessary for identification.

No approval card containing the screenshot's command fragment exists in the relay outbox. A diagnostic subscription to the already-loaded child succeeded, but no pending request was replayed at inspection time. No response was sent. The historical request may already have resolved; that probe cannot establish whether the original request reached the relay transport before being discarded, or was missed during reconnection.

The pre-fix code had a deterministic routing defect: `Bridge.request()` looked up the saved binding using `request.params.threadId` and returned immediately if there was no attached binding. `CodexClient.list()` deliberately excludes subagents from interactive session discovery, so they have no individual topic binding. A child approval reaching the transport was therefore silently discarded even when its parent was attached and authorized.

## Native delivery and replay

In Codex 0.166.0, approval parameters retain the executing child's thread ID. The construction uses the event's `conversation_id`, rather than rewriting it to the root. [Official event handling source](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/bespoke_event_handling.rs).

When a thread is created, the server can attach already initialized connections as listeners. Thus a connected relay may receive a newly spawned child's live request even without explicitly resuming the child. [Official server source](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/lib.rs).

Reconnection has a separate gap. Resuming the parent replays requests for that exact parent ID. The pending-request filter compares `entry.thread_id` with the requested ID; it does not traverse descendants. A relay reconnecting after child creation needs a subscription to eligible loaded children to recover their pending approvals. [Resume lifecycle](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs), [pending-request filtering](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/outgoing_message.rs).

These contracts establish two failure mechanisms, not the precise historical transport timing of the screenshot's request.

## Reproduction

The ignored diagnostic harness uses the actual Bridge with a temporary database and synthetic adapters:

```text
node .local/bug-verification/child-approval-repro.mjs
{"parentHasTopic":true,"childHasTopic":false,"nativeRequestPending":true,"deliveredApprovals":0,"nativeResponsesSent":0}
AssertionError: BUG: a pending child approval is silently dropped instead of reaching its authorized parent topic
```

Exit code 1 is the deliberate failing assertion documenting the defect. No real command or approval was executed. The first-message correction does not address this failure.

## Implemented behavior

Route subagent approvals to the attached parent/root topic, with the agent's name and ID visible. Continue giving ordinary interactive root sessions their own topics. Keep the execution request's child thread/turn/item identity intact.

The correction implements these requirements:

1. Resolve ancestry from current native metadata to one authorized, attached root. Validate the chain, bound traversal, reject cycles/missing ancestors, and distinguish spawned subagents from unrelated or forked interactive sessions. Never infer ancestry from a directory, display name or short ID.
2. Discover and subscribe to currently loaded descendants of that root, including after reconnect, without creating child topics, restoring unloaded agents, or sending `turn/start`/`turn/steer` to them.
3. Store origin identity separately from the destination binding. Preserve the original pending RPC ID and one-time owner/topic-bound approval token. Recheck the current ancestry, scope, ignored IDs, binding and request liveness before answering.
4. Route resolution and child-turn lifecycle events using the origin child. Keep file-change caches and approval deduplication keyed by the child identities. A parent turn finishing must not clear an unrelated child's pending approval; terminal resolution must retire its Telegram controls.
5. Retain existing conservative rendering and permission handling. If ancestry or the full file-change details cannot be verified, use a clear terminal-only notice where an authorized destination is known. A child's `canAcceptDirectInput: false` must not be overridden to make approval routing work.

Simply replacing `request.params.threadId` with the parent ID would be incorrect: it would conflate origin with destination and break lifecycle and diff correlation.

## Verification

- A newly spawned child approval reaches its parent's topic and identifies its source.
- A pending child approval is replayed after relay reconnect, with no duplicated decision.
- Nested descendants resolve to the right root; siblings sharing a short prefix stay distinct.
- Replies in another topic, removed/ignored ancestors, changed scope and stale native requests cannot authorize the action.
- Resolving in the terminal retires the Telegram controls; child completion and parent completion are handled independently.
- Complete child file-change details are preserved, and unavailable details remain terminal-only.
- No new sessions or child topics are created and no direct model input is sent to child agents.

The tracked integration suite uses the real CodexClient WebSocket transport, Bridge, SQLite state and synthetic native/Telegram peers. The reconnect check closes the old client and proxy, opens a new transport, and verifies stale controls cannot answer pending work. Its initial fixture used a new RPC ID. The subsequent [repeated-card correction](repeated-approval-cards-2026-11-05.md) aligns the fixture with the reviewed daemon's replay of the same RPC ID and verifies one existing card with fresh controls. This is not a real daemon reconnect acceptance test.

Review found an additional replay gap when Telegram reports a missing parent topic. Recovery retired the old child controls but retained the child's subscription cache, so only root requests were replayed. A failing regression observed one card instead of the expected replacement card. Topic retirement now invalidates descendant subscriptions before discovery; the regression verifies the new destination and a single response to the original child RPC.

The initial diagnostic adapter was extended with the full native spawn/source metadata now required for ancestry validation. It now reports one delivered parent-topic card, no child topic and no native response. The seven tracked child-approval scenarios pass, including transport reconnect, root-topic recovery, stale and foreign controls, nested/cyclic/out-of-scope ancestry, origin-specific lifecycle and file diffs. See [the verification record](../verification.md) for the full suite result.

Implementation: [ancestry resolver](../../src/subagents.ts), [routing and lifecycle](../../src/bridge.ts), [integration tests](../../test/subagent-approvals.test.ts). Traversal visits at most 16 contexts; discovery subscribes to at most 128 eligible loaded children and warns when the limit is reached. Unsupported child questions remain terminal-only. Native permissions and the child's inability to accept direct input are preserved.

A final read-only probe ran the new ancestry resolver against the screenshot child's live native metadata and its loaded root's saved binding. It resolved the expected existing parent topic and confirmed the child has no independent binding. The probe sent no model input or approval response and created no topic. This verifies metadata compatibility, not the running relay's event delivery.

The built correction needs a relay process restart. Historical missing requests that have already resolved cannot be recreated. Live end-to-end acceptance of a newly pending child approval remains to be observed; no real approval was fabricated for testing.
