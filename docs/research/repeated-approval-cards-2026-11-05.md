# Repeated unanswered approval cards

Date: 2026-11-05. Upstream review targets Codex `rust-v0.166.0` and the official Telegram Bot API documentation available on this date. The correction is implemented on `dev` and verified with synthetic integration tests. Diagnosis and tests did not submit a real approval, send model input, change runtime configuration, or restart the running relay.

## Local finding

The pre-fix relay republishes an unchanged pending approval on reconnect. The inspected baseline was `286afd7` on `dev`; the diagnosis was recorded in `e1e76fc` before implementation. Subagent routing exposed approvals to their parent topic while retaining the existing generation-based card delivery identity.

A read-only outbox inspection found 20 identical child-labelled approval presentations in one topic between 15:21:56 and 15:26:51 UTC. Every row has a different relay generation. Four deliveries are confirmed `sent`, fifteen are `uncertain`, and one is `cancelled`; this is not evidence that all twenty reached Telegram. Most adjacent enqueue intervals were approximately fifteen seconds, rather than a fixed one-minute schedule. Real commands, session IDs, topic IDs and callback capabilities are omitted from this report.

Rendered command cards deliberately omit turn/item transport metadata, so their matching text hashes cannot establish historical native request identity by themselves. The controlled reproduction below independently proves the reconnect defect for the same still-pending RPC ID and unchanged request parameters.

### Mechanism

In the pre-fix code:

1. [`Bridge`](../../src/bridge.ts) creates a fresh `generation` and in-memory `prompts` map for every native connection. Its request deduplication checks only the current map's RPC IDs.
2. After reconnect, native resume replays an outstanding approval. The empty map accepts it and allocates a new callback token.
3. `promptKey()` includes both the connection generation and token. [`State.enqueue()`](../../src/state.ts) deduplicates by that key, so the old delivered or uncertain card does not suppress the new row.
4. [`Outbox`](../../src/telegram.ts) correctly leaves an individual ambiguous send `uncertain`, but the next Bridge creates another logical delivery under a different key. Thus replay bypasses uncertainty protection at the presentation layer.

There was also transport coupling in [`start()`](../../src/cli.ts): a `getUpdates` error escaped to the connection loop's outer catch/finally, closed the native client, discarded the Bridge, and reconnected after a three-second delay. A transient Telegram polling failure could therefore trigger native approval replay even when Codex itself was healthy. The polling timeout is 35 seconds; ordinary Telegram calls use 15 seconds and underlying failures can occur earlier. Those constants do not establish the exact historical reconnect cause. Runtime stderr was not persisted in the available relay state directory, so that cause remains unconfirmed.

### Controlled reproduction

The ignored diagnostic script uses the actual built Bridge, SQLite state and Outbox with synthetic native/Telegram adapters. It neither contacts a real bot nor answers a real request:

```text
node .local/bug-verification/repeated-approval-repro.mjs steady
node .local/bug-verification/repeated-approval-repro.mjs reconnect
node .local/bug-verification/repeated-approval-repro.mjs uncertain
```

Each scenario delivers three native request events without any decision. `reconnect` rebuilds the Bridge and clears the simulated disconnected client's pending set while retaining the same request ID and parameters. `uncertain` additionally simulates Telegram accepting the card before its acknowledgement is lost; the sender catches the error and continues as it does in the running relay.

| Scenario | Submissions before | Submissions after | Uncertain after |
| --- | ---: | ---: | ---: |
| Same request repeated within one connection | 1 | 1 | 0 |
| Same pending request across three connections | 3 | 1 | 0 |
| Same pending request across connections after lost send acknowledgements | 3 | 1 | 1 |

All scenarios send zero native approval decisions. The original failures were deliberate bug assertions; the same harness now passes. An additional case with three different RPC IDs still produces three cards, correctly treating them as independent native requests. It is not evidence that the daemon changed IDs in this incident.

Existing tests explain the coverage gap: `reconnection does not spam an unchanged background approval` in [bridge tests](../../test/bridge.test.ts) exercises a terminal-only notice for a file request without a diff, whose attention key is already stable. It does not exercise a supported approval card with buttons. The [subagent reconnect test](../../test/subagent-approvals.test.ts) previously expected two cards; it now replays the same native RPC ID, as the reviewed daemon does, and verifies one card with refreshed controls and one native decision.

## Confirmed upstream behavior

**A pending native request keeps its RPC ID when replayed by the same daemon.** `send_request_to_connections()` allocates an ID and stores the complete request in `PendingCallbackEntry`. `pending_requests_for_thread()` clones that stored request; `replay_requests_to_connection_for_thread()` sends the clone directly, without allocating another ID. A reconnect alone therefore does not require a different ID. This does not make the ID a durable global identity: the counter belongs to the sender instance, and a recreated request or daemon has a different lifetime. [Codex outgoing request implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/outgoing_message.rs).

**Replay follows subscription, not a periodic reminder timer.** The running-thread resume handler subscribes the connection, sends the resume result, and replays pending requests for that exact thread. Its separate unloading delay applies only when the thread has no subscribers and is inactive. It is not an approval expiry or reminder. [Codex thread lifecycle](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs).

**The inspected approval wait path has no one-minute timeout or resend loop.** Command-execution and file-change approval handlers await their response channels directly (`receiver.await`). Their completion paths handle responses, cancellation/errors and turn transitions. Together with request creation/replay and the resume handler above, this provides no evidence for a native once-per-minute approval reminder. This is a finding about these reviewed paths, not proof that every possible transport failure has been excluded. [Codex approval handlers](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/bespoke_event_handling.rs).

## Telegram card reuse and recovery limits

`editMessageReplyMarkup` updates an existing card's inline keyboard using its known `chat_id` and `message_id`. `editMessageText` can update its text and keyboard together using the same identifiers. Successful non-inline edits return the edited `Message`; these methods do not create a replacement message. The documented 48-hour qualification concerns certain business messages not sent by the bot, not a general limit on its own approval cards. [Updating messages](https://core.telegram.org/bots/api#updating-messages), [editMessageReplyMarkup](https://core.telegram.org/bots/api#editmessagereplymarkup), [editMessageText](https://core.telegram.org/bots/api#editmessagetext).

`getUpdates` delivers incoming updates, retained for at most 24 hours; it is not arbitrary forum-topic history lookup. Telegram's general MTProto `messages.getHistory` method is user-only. Consequently, durable send receipts are needed to identify previously delivered cards; an unknown send outcome cannot simply be reconciled by asking the Bot API to search topic history. [Bot update delivery](https://core.telegram.org/bots/api#getting-updates), [history endpoint restriction](https://core.telegram.org/method/messages.getHistory).

## Implications and remaining hypotheses

The source supports investigating reconnect-driven replay rather than assuming a native reminder timer. A fresh relay generation can accidentally treat a replay as a new notification even when its RPC ID is unchanged. Whether a particular historical duplicate followed that path must be established separately from relay state or reproduction; identical rendered text alone does not prove identical native request identity.

The correction separates card delivery identity from callback authority. A verified, still-pending request reuses a known delivered card while its callback is refreshed for the current connection. Matching distinguishes new approval requests, originating child threads and different turns/items; neither displayed text nor an unscoped RPC ID is sufficient. An uncertain send remains uncertain instead of automatically triggering another `sendMessage`.

## Implemented correction

1. Persist the logical pending approval and its presentation separately from connection-scoped callback tokens. Match the origin, request lifetime and complete proposal/permission context; preserve distinctions between unrelated requests that happen to run the same command. Retain active records while the request remains pending.
2. When a still-pending request is replayed into the same destination, refresh the current RPC mapping and edit the known card's keyboard. Preserve owner/topic checks, live ancestry/scope checks and one-time decisions. Changed proposal content or a genuinely new request must be reviewed as such. A recovered destination topic needs a new card because the original message belongs to the old destination.
3. Preserve ambiguous delivery outcomes across connection generations. Without a confirmed message receipt, do not automatically submit another card; use explicit owner recovery or terminal handling. Editing a known message can be retried without manufacturing a new message. Multipart cards must retain their complete review context and trustworthy final-button receipt.
4. Retry transient Telegram polling failures with bounded backoff without closing a healthy native connection. Preserve fatal handling of competing bot pollers and authentication failures. Sanitized polling outage/recovery notices distinguish those failures from the existing native reconnect log.

The SQLite request ledger fingerprints the full native method, typed RPC ID and parameters. A separate card record keeps the destination/presentation, outbox key and current callback owner. A native decision becomes consumed before responding, independent of destination, so reconnect and topic recovery cannot rearm an uncertain write. Startup holds unsent cards until verified replay; admission still respects queue capacity. Pending/consumed receipts survive normal seven-day pruning. Native resolution also retires held cards absent from the in-memory Bridge.

The [approval replay suite](../../test/approval-replay.test.ts) covers repeated replay, actual SQLite reopen, confirmed/uncertain delivery, uncertain native decisions, topic recovery, multipart review text, changed proposals, distinct typed IDs, receipt retention, queue capacity, owner/topic/stale-token rejection and one response. Review also reproduced and fixed delayed HTTP edits after a new Bridge takes ownership or after the decision closes, plus a delayed missing-topic error that must not replace a healthy recovered binding.

The [CLI polling suite](../../test/polling.test.ts) launches the actual CLI and stdio/WebSocket transport with local peers and fully intercepted Telegram calls. A network failure followed by a rate limit previously started three native proxy clients; it now starts one. Authentication failure and a competing consumer each stop after one client, without reconnect loops.

## Verification and rollout limits

Windows: **201 tests, 199 passed, two platform skips, zero failures**. Type checking, build and distribution checks passed. Two independent reviews found no remaining confirmed defects after the race fixes. The original reconnect and lost-acknowledgement reproductions are green. No real approval was created or answered for these checks.

The running foreground relay needs a restart to load the built correction. Legacy outbox rows lack complete native identity and cannot safely be adopted by matching text; the first replay after upgrade may create one new card. Subsequent replays use its durable receipt. A new native request or changed proposal remains a separate review. If the first send outcome is unknown, answer in Codex instead of expecting an automatic replacement. Live acceptance after restart remains to be observed; the precise historical trigger for native connection churn is still unconfirmed.
