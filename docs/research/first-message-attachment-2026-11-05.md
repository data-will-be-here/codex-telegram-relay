# Native attachment before the first message

Date: 2026-11-05. Initial investigation at `dev` commit `80b10a5`, followed by the authorized correction below. Runtime inspected: Codex CLI 0.166.0; relay package 0.1.16 with development changes. No first model message was injected into a user session.

## Confirmed diagnosis

A newly opened native session can be listed as loaded and return a nonempty rollout path before that file exists. The relay interprets this metadata as sufficient for discovery, creates a Telegram topic, and then fails to attach. Its generic unavailable/attachment-failed messages conceal the expected pre-first-message state.

This was reproduced twice against the user-selected empty session, which remained idle and had no rollout file after the probes. The exact native responses, with session identifiers removed, were:

| Operation | Result |
| --- | --- |
| `thread/loaded/list` | Session is present |
| `thread/read` | `source: vscode`, `status: idle`, nonempty `path`; file does not exist |
| Raw `thread/turns/list` | `not materialized yet; thread/turns/list is unavailable before first user message` |
| Relay `CodexClient.turns()` | Successful empty array, because the wrapper catches that error |
| `thread/resume` with `{threadId, excludeTurns: true}` | `no rollout found for thread id ...` |

The saved topic exists, project scope permits the session, the session is not ignored, and there is no pending topic-creation recovery. Neither Telegram topic recreation nor repeated `/bind` can supply the missing initial native input.

The originally reported session had started this diagnostic conversation by the time it was probed. Its first stored task began at 17:10:25 Moscow time; the three recorded unavailable warnings for it were at 17:06:07, 17:06:21, and 17:07:49. Its history read, attachment, post-attachment history read, and asynchronous-question reader all succeeded. The existing relay also recorded successful delivery of messages from this conversation. This supports recovery after materialization, but is not a controlled before/after experiment on the still-empty session: no first message was injected there.

## Code path

- [`src/codex.ts`](../../src/codex.ts), `CodexClient.list()`: the readiness filter rejects a null/empty path, not a reserved path whose history is not yet materialized.
- [`src/codex.ts`](../../src/codex.ts), `turns()` and `attach()`: the former converts the specific pre-first-message rejection to `[]`; the latter propagates the resume rejection.
- [`src/bridge.ts`](../../src/bridge.ts), `discover()`: `topics.ensure()` runs before history/attachment. The error handler removes the session from the attached set and enqueues the generic warning.
- [`src/bridge.ts`](../../src/bridge.ts), `connectionStatus()`: a session still present in discovery receives the generic loaded-but-not-attached explanation, without identifying the missing first message.

The same distinction is present in [the official Codex 0.166.0 implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_processor.rs): `read_thread_view()` can use live state when persisted history is absent, while `resume_running_thread()` reads stored metadata; `thread_store_resume_read_error()` maps a missing stored thread to the observed resume error. `thread_turns_list_history_load_error()` defines the observed pre-first-message history error. Loaded metadata therefore does not guarantee resumability.

## Why warnings repeat

The warning key is `session-unavailable/${generation}/${session.id}`. A single Bridge instance deduplicates repeated discovery failures, but a new Bridge after reconnection/restart generates a new key. Multiple generations were observed in the private state database. An isolated replay confirmed one warning across repeated scans of the same Bridge, and a second warning after constructing another Bridge against the same saved state.

[`src/cli.ts`](../../src/cli.ts) creates Bridge instances inside its reconnect loop. Discovery is scheduled roughly every five seconds; that is not the reported five-to-ten-minute warning cadence. The evidence establishes the repeated-warning mechanism, not the underlying reason for each transport reconnection. This diagnosis does not claim that empty sessions cause those reconnections.

## Reproduction and validation

The ignored diagnostic harness `.local/bug-verification/first-message-repro.mjs` replays the observed native replies through the actual `CodexClient`, `Bridge`, `State`, and `Outbox`, using synthetic Telegram calls and a disposable database. It does not use the real bot or daemon.

```text
node .local/bug-verification/first-message-repro.mjs
before-first-message {"topicCreated":true,"warningCount":1,"genericAttachmentFailure":true,"nativeInputs":0}
same-connection-warning-count 1
new-connection-warning-count 2
after-materialization {"nativeInputs":1,"topicCount":1}
AssertionError: BUG: a topic is created before this session can be attached
```

Exit code 1 is the intentional failing assertion for the proposed readiness behavior. The observed first instruction was rejected rather than replayed; only a later synthetic instruction was accepted after the adapter became ready, using the same topic.

Existing focused tests were also run:

```text
node --test --test-reporter=spec dist/test/codex.test.js dist/test/topic-recovery.test.js
15 passed, 0 failed, 0 skipped
```

Their coverage gap is concrete: [`test/fake-proxy.mjs`](../../test/fake-proxy.mjs) represents the empty session with `path: null`, so discovery excludes it. The live native session instead has a nonempty reserved path. Generic attachment-failure tests do not assert the pre-first-message experience.

## Recommended correction

Treat a confirmed pre-first-message response as an explicit waiting state. Check readiness before creating a new topic, and wait for normal discovery after the first local message. Existing saved topics should explain that first local input is required. Preserve the distinction between an unmaterialized session and a valid session with an empty history; a generic missing-rollout error alone must not hide unrelated failures.

Keep saved bindings, do not submit an artificial initial prompt, and do not replay rejected Telegram instructions. Avoid re-emitting unavailable warnings for this expected state after every reconnect. Extend transport and Bridge coverage with the real combination of a nonempty reserved path, unavailable history, and rejected resume, followed by readiness and successful reuse of the saved topic.

The immediate workaround is to send the first ordinary message in that exact local Codex conversation. The relay can then retry attachment to its existing topic. `/bind` in that saved topic can request another attempt after the native session is ready.

## Implemented correction

The follow-up request authorized implementation. `FirstMessageRequiredError` now preserves the specific native waiting state instead of returning an empty array. Discovery checks summarized history before topic creation/replacement and attachment. It silently retries waiting sessions; saved-topic text/media replies and explicit recovery explain the need for the first local message. The original binding remains ahead of attachment so native replayed approvals retain their destination.

An in-memory, discovery-bounded record of observed unmaterialized sessions preserves their first completed answer when it finishes before the next scan. A completion already present before this connection ever observes the session retains the existing no-history-import behavior. Rejected Telegram instructions are not replayed. No thread creation or automatic initial prompt was added.

Protocol research found no readiness/materialized field in the installed `Thread` schema. `path` is unstable metadata; filesystem existence and `canAcceptDirectInput` do not establish persisted history. The summarized-history endpoint was selected because it reads history without subscribing or submitting a turn. In contrast, `thread/read(includeTurns:true)` can persist a paginated thread, making it unsuitable as a passive readiness check. These behaviors were checked in the official 0.166.0 source linked above.

The tracked regressions are in `test/first-message.test.ts` and `test/codex.test.ts`, using `test/fake-proxy.mjs` to model the observed reserved-path response. Each behavior-changing regression was observed failing before its fix. Full local Windows validation: 175 tests, 173 passed, two platform-specific skips, zero failures. Live acceptance of a restarted relay is separate from these checks.
