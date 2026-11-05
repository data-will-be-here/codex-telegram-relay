# Repeated unanswered approval cards

Date: 2026-11-05. Upstream review targets Codex `rust-v0.166.0` and the official Telegram Bot API documentation available on this date. This research did not submit an approval, send model input, change runtime configuration, or restart processes.

## Local finding

The relay republishes an unchanged pending approval on reconnect. The inspected code is `286afd7` on `dev`. The new subagent routing exposes approvals to their parent topic, but retains the existing generation-based card delivery identity. This investigation changes no application code.

A read-only outbox inspection found 20 identical child-labelled approval presentations in one topic between 15:21:56 and 15:26:51 UTC. Every row has a different relay generation. Four deliveries are confirmed `sent`, fifteen are `uncertain`, and one is `cancelled`; this is not evidence that all twenty reached Telegram. Most adjacent enqueue intervals were approximately fifteen seconds, rather than a fixed one-minute schedule. Real commands, session IDs, topic IDs and callback capabilities are omitted from this report.

Rendered command cards deliberately omit turn/item transport metadata, so their matching text hashes cannot establish historical native request identity by themselves. The controlled reproduction below independently proves the reconnect defect for the same still-pending RPC ID and unchanged request parameters.

### Mechanism

1. [`Bridge`](../../src/bridge.ts) creates a fresh `generation` and in-memory `prompts` map for every native connection. Its request deduplication checks only the current map's RPC IDs.
2. After reconnect, native resume replays an outstanding approval. The empty map accepts it and allocates a new callback token.
3. `promptKey()` includes both the connection generation and token. [`State.enqueue()`](../../src/state.ts) deduplicates by that key, so the old delivered or uncertain card does not suppress the new row.
4. [`Outbox`](../../src/telegram.ts) correctly leaves an individual ambiguous send `uncertain`, but the next Bridge creates another logical delivery under a different key. Thus replay bypasses uncertainty protection at the presentation layer.

There is also transport coupling in [`start()`](../../src/cli.ts): a `getUpdates` error escapes to the connection loop's outer catch/finally, closes the native client, discards the Bridge, and reconnects after a three-second delay. A transient Telegram polling failure can therefore trigger native approval replay even when Codex itself is healthy. The current polling timeout is 35 seconds; ordinary Telegram calls use 15 seconds and underlying failures can occur earlier. Those constants do not establish the exact historical reconnect cause. Runtime stderr was not persisted in the available relay state directory, so that cause remains unconfirmed.

### Controlled reproduction

The ignored diagnostic script uses the actual built Bridge, SQLite state and Outbox with synthetic native/Telegram adapters. It neither contacts a real bot nor answers a real request:

```text
node .local/bug-verification/repeated-approval-repro.mjs steady
node .local/bug-verification/repeated-approval-repro.mjs reconnect
node .local/bug-verification/repeated-approval-repro.mjs uncertain
```

Each scenario delivers three native request events without any decision. `reconnect` rebuilds the Bridge and clears the simulated disconnected client's pending set while retaining the same request ID and parameters. `uncertain` additionally simulates Telegram accepting the card before its acknowledgement is lost; the sender catches the error and continues as it does in the running relay.

| Scenario | Telegram card submissions | Uncertain deliveries | Result |
| --- | ---: | ---: | --- |
| Same request repeated within one connection | 1 | 0 | Pass |
| Same pending request across three connections | 3 | 0 | Fails: expected one card |
| Same pending request across connections after lost send acknowledgements | 3 | 3 | Fails: ambiguous delivery must not cause a new submission |

All scenarios send zero native approval decisions. The failures are deliberate bug assertions, not unrelated test errors. An additional synthetic case with different RPC IDs in one Bridge also produces three cards; it is a defensive case, not evidence that the daemon changed IDs in this incident.

Existing tests explain the coverage gap: `reconnection does not spam an unchanged background approval` in [bridge tests](../../test/bridge.test.ts) exercises a terminal-only notice for a file request without a diff, whose attention key is already stable. It does not exercise a supported approval card with buttons. The [subagent reconnect test](../../test/subagent-approvals.test.ts) verifies fresh controls and one native decision, but currently expects two sent cards after reconnect. That expectation needs to change when card reuse is implemented; fresh controls do not require a fresh message.

## Confirmed upstream behavior

**A pending native request keeps its RPC ID when replayed by the same daemon.** `send_request_to_connections()` allocates an ID and stores the complete request in `PendingCallbackEntry`. `pending_requests_for_thread()` clones that stored request; `replay_requests_to_connection_for_thread()` sends the clone directly, without allocating another ID. A reconnect alone therefore does not require a different ID. This does not make the ID a durable global identity: the counter belongs to the sender instance, and a recreated request or daemon has a different lifetime. [Codex outgoing request implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/outgoing_message.rs).

**Replay follows subscription, not a periodic reminder timer.** The running-thread resume handler subscribes the connection, sends the resume result, and replays pending requests for that exact thread. Its separate unloading delay applies only when the thread has no subscribers and is inactive. It is not an approval expiry or reminder. [Codex thread lifecycle](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs).

**The inspected approval wait path has no one-minute timeout or resend loop.** Command-execution and file-change approval handlers await their response channels directly (`receiver.await`). Their completion paths handle responses, cancellation/errors and turn transitions. Together with request creation/replay and the resume handler above, this provides no evidence for a native once-per-minute approval reminder. This is a finding about these reviewed paths, not proof that every possible transport failure has been excluded. [Codex approval handlers](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/bespoke_event_handling.rs).

## Telegram card reuse and recovery limits

`editMessageReplyMarkup` updates an existing card's inline keyboard using its known `chat_id` and `message_id`. `editMessageText` can update its text and keyboard together using the same identifiers. Successful non-inline edits return the edited `Message`; these methods do not create a replacement message. The documented 48-hour qualification concerns certain business messages not sent by the bot, not a general limit on its own approval cards. [Updating messages](https://core.telegram.org/bots/api#updating-messages), [editMessageReplyMarkup](https://core.telegram.org/bots/api#editmessagereplymarkup), [editMessageText](https://core.telegram.org/bots/api#editmessagetext).

`getUpdates` delivers incoming updates, retained for at most 24 hours; it is not arbitrary forum-topic history lookup. Telegram's general MTProto `messages.getHistory` method is user-only. Consequently, durable send receipts are needed to identify previously delivered cards; an unknown send outcome cannot simply be reconciled by asking the Bot API to search topic history. [Bot update delivery](https://core.telegram.org/bots/api#getting-updates), [history endpoint restriction](https://core.telegram.org/method/messages.getHistory).

## Implications and remaining hypotheses

The source supports investigating reconnect-driven replay rather than assuming a native reminder timer. A fresh relay generation can accidentally treat a replay as a new notification even when its RPC ID is unchanged. Whether a particular historical duplicate followed that path must be established separately from relay state or reproduction; identical rendered text alone does not prove identical native request identity.

For a future correction, card delivery identity and callback authority should be separate. A verified, still-pending request can reuse a known delivered card while its callback is refreshed for the current connection. Matching must distinguish new approval requests, originating child threads and different turns/items; neither displayed text nor an unscoped RPC ID is sufficient. An uncertain send must remain uncertain rather than automatically triggering another `sendMessage`. These are design implications, not changes implemented by this research.

## Recommended correction

1. Persist the logical pending approval and its presentation separately from connection-scoped callback tokens. Match the origin, request lifetime and complete proposal/permission context; preserve distinctions between unrelated requests that happen to run the same command. Retain active records while the request remains pending.
2. When a still-pending request is replayed into the same destination, refresh the current RPC mapping and edit the known card's keyboard. Preserve owner/topic checks, live ancestry/scope checks and one-time decisions. Changed proposal content or a genuinely new request must be reviewed as such. A recovered destination topic needs a new card because the original message belongs to the old destination.
3. Preserve ambiguous delivery outcomes across connection generations. Without a confirmed message receipt, do not automatically submit another card; use explicit owner recovery or terminal handling. Editing a known message can be retried without manufacturing a new message. Multipart cards must retain their complete review context and trustworthy final-button receipt.
4. Retry transient Telegram polling failures with bounded backoff without closing a healthy native connection. Preserve fatal handling of competing bot pollers and authentication failures. Record a sanitized reconnect reason so future incidents distinguish Telegram polling, native transport and discovery failures.

Acceptance checks should cover repeated idle discovery, repeated native replay, actual reconnect and process restart, changed RPC IDs without unsafe identity merging, successful and ambiguous prior delivery, topic recovery, multipart approvals, owner/topic/stale-token rejection and one native response. A time-based notification throttle alone would conceal the duplicate mechanism and could hide a genuinely new approval.

Status: diagnosis and proposed behavior are complete; the correction above is not implemented in this research turn. The precise historical trigger for native connection churn remains unconfirmed.
