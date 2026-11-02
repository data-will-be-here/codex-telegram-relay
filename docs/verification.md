# Verification record

Initial local qualification: 2026-11-02, Windows, Node.js 22.21.1, Codex CLI/shared daemon 0.166.0.

## 0.1.12 automatic discovery

Windows validation: 98 tests, 96 passed and two Unix-only tests skipped; type checking and package-content checks passed. Regression coverage verifies a later session in a new project receives one persistent topic, accepts native input and returns assistant output in automatic mode; ignored sessions remain excluded. Topic recovery also accepts explicitly enabled automatic scope while retaining ignored-session checks. Selected-project regressions remain unchanged. Runtime dependency audit reported zero known vulnerabilities.

The implementation commit c5c0b48 passed all six CI jobs on Windows, macOS and Linux with Node 22/24. Release instructions point agents to main and installation to the version tag; selected-project defaults remain unchanged.

A read-only check against the existing daemon confirmed the missing new-project session was loaded but outside selected roots. After explicitly enabling automatic scope in the local configuration, that same session passed directory eligibility and the previously ignored session remained ignored. No model turn or native attachment was used for this check. Real topic creation under the new mode still requires restarting the existing relay and observing the resulting binding.

## Public preview acceptance

Version 0.1.11 passed CI on Windows/macOS/Linux with Node 22/24. The final Windows environment fix isolates the ACL helper from inherited PowerShell 7 module paths. Real Telegram photo input reached the selected native session and was visually identified. A live host-question choice returned from Telegram to that same session, confirming the reverse question-answer path. Full authenticated installation and bot exchange on a clean Mac/Linux machine, and sleep/network-outage acceptance, remain follow-up checks; they are not implied by CI success.

## 0.1.11 audited fixes

Regression tests first reproduced broad pre-existing Windows grants, silent oversized/capacity-limited questions, a question disappearing after a later turn/reconnect, an answer consumed before any native write, and partial answers lost across a new RPC ID. These scenarios now pass through the real configuration/reader/Bridge interfaces with synthetic native/Telegram adapters. Windows tests inspect actual filesystem ACLs on disposable directories/files; repeated saves preserve access without requiring audit-policy privileges. SQLite reopen tests verify interrupted host-answer attempts remain non-replayable and matching drafts/recovery timestamps survive.

Missing-executable tests verify native rediscovery changes only the in-memory candidate until compatibility checks succeed; tokens/config remain byte-identical during resolution. Existing invalid files are rejected unless explicitly overridden. Runtime start checks initialization and the loaded-session interface before saving a replacement path. Installation of official Codex on CI remains a command/install smoke check; a complete live Mac installation is still an acceptance check.

## 0.1.10 journal recovery

Large-journal tests reproduced both false restart/next-turn warnings and an actual current question lost before a 9 MiB tool output. They pass with streamed recovery, including an answer after a large output suppressing an already resolved question. Read-only checks of four selected live journals (largest approximately 99 MiB) returned no false recovery markers; native sessions were not modified. A real Telegram photo subsequently reached the native conversation and was visually identified, completing the incoming-photo acceptance check. The later public-preview acceptance above includes a real returned host-question choice.

## Automated

Version 0.1.9 adds synthetic tests for owner/root checks before attachment download, safe random cache paths, caption forwarding, image input framing, native-question attachment answers, actual streamed download limits, path traversal and token-error redaction. Host async-question tests cover split journal records, current-turn filtering, native UI answers, secret-format fallback, topic isolation, free-text answers and reconnect consumption. Stale-approval and missing-partial-answer tests failed before their fixes and now pass. The bounded journal reader also recovered the actual missing questions from a selected native session without printing their contents. A real Telegram question copy was accepted in the saved project topic. Later photo and host-question acceptance results are recorded above.

The test suite exercises session/topic routing, duplicate input suppression, owner/private-chat checks before journaling, busy-turn steering, uncertain-write handling, commentary filtering, completion deduplication, one-shot topic-scoped approvals, native resolution, multi-question capability rotation, unsupported/oversized requests, root containment, policy changes being unavailable remotely, SQLite recovery and lock handling, token-error redaction, Unicode chunking, and HTTP/WebSocket-over-pipes framing.

Normal automated tests use synthetic data and no real bot credentials or model turns. `npm audit` reported no known advisories for the locked runtime and development dependencies at the time of qualification. That result is time-dependent.

## Native acceptance checks performed locally

Two independent clients connected to the real existing shared daemon. An isolated test project and test native context were used; unrelated user sessions were not resumed or modified. A Telegram test adapter replaced Telegram's network calls.

Verified:

1. HTTP upgrade and WebSocket messages over `codex app-server proxy`.
2. Loaded-session discovery separates interactive root sessions from subagents and skips ephemeral/unmaterialized contexts.
3. A second client resumes the selected test thread without changing its read-only sandbox or on-request policy.
4. A real no-tools model answer is received by the second client and delivered as a final Telegram-adapter message.
5. A native command-execution approval initiated by the first client arrives at the second client. A simulated owner click sends the native cancellation decision. The requested elevated echo is not executed.
6. A native multiple-choice question is answered through a simulated Telegram callback.
7. A steering message is accepted for that same active native turn.

The native server offered `accept` and `cancel` for the tested approval, rather than `decline`. The relay now renders the advertised choices and has a regression test for this case. A blank native context cannot be resumed before its first input; discovery waits for materialization instead of creating replacement sessions.

## Installation acceptance checklist

- Configure a dedicated BotFather bot with private topics and complete owner pairing (performed for one local installation; repeat for each installation).
- Confirm topic creation, final delivery and native questions in an actual Telegram client (performed locally). Real-client approval acceptance remains to be checked; automated approval qualification used the adapter.
- Confirm behaviour after the local computer sleeps and reconnects.
- Verify actual account-specific native approval modes, including any managed or automatic reviewer policies.

No real Telegram exchange, password prompt, file transfer or production deployment is claimed by the synthetic tests or the native-adapter checks.

## 0.1.1 reconnect regression

A real installation exposed a history response exceeding the client's 16 MiB WebSocket limit. The error had been incorrectly labelled as an unavailable daemon. Each reconnect also re-enqueued warnings about an unchanged background approval.

Both failures were reproduced before the fix: a synthetic large-history test disconnected, and four reconnects produced eight warnings instead of one. After switching to display summaries and persistent native attention keys, all 27 tests pass. The same installation's sessions were checked across three native connection cycles with a separate SQLite store and Telegram simulator: no transport disconnect and one terminal-only warning for the unchanged request. The real bot's token, bindings and state were not modified by this verification.

## Live acceptance and 0.1.6 delivery regression

A paired real bot was subsequently checked for topic creation, bidirectional messages, Markdown entities and a native multiple-choice question in a separate test session. A selected answer reached that session and its final response returned to Telegram. These checks do not replace clean-machine or sleep/reconnect acceptance checks.

Two completed answers containing localhost preview links reached the relay but were rejected by Telegram. A controlled live request reproduced HTTP 400 `Wrong HTTP URL`; the local-link and definite-entity-rejection regression tests failed before the fix. After rendering local previews as text, both stored answers were delivered to their original topic without repeating native Codex input. Automated tests also cover switching/persisting message modes, owner checks, commentary deduplication, and plain-text fallback without replaying accepted multipart output.

## 0.1.7 discovery and topic recovery

The unavailable-session, ambiguous-topic-creation and missing-topic scenarios were reproduced using synthetic adapters before the fix. Regression coverage now includes a disappearing thread, a failed resume alongside healthy sessions, transport errors still triggering reconnect, interrupted topic creation across restart, explicit binding/retry, rate limits, and deleted-topic replacement with queued answers preserved. A combined scenario checks that other topics remain usable during uncertain replacement, old approval buttons stay inert, and new buttons require a fresh owner click.

Project signatures are checked for italic styling without full paths, UTF-16 offsets, each multipart message, project notices outside topics, and migration of older SQLite outbox schemas. The recovery tests never delete or rebind real user topics or mutate real Codex sessions.

## 0.1.8 topic display and native executable discovery

Historical record: status topic names were removed in 0.1.9 at the owner's request. Current names remain project/short-ID.

Tests cover owner-only title-mode changes, persisted preferences, idempotent renaming, Telegram rename rate limits, duplicate visible names routing to different native threads, and reconnects without topic creation. Status mode intentionally omits dialogue names and IDs; simple mode preserves the original format.

Unix CI tests resolve an executable symlink and an npm launcher backed by a hoisted native platform package without executing the launcher. A separate installation check downloads official Codex 0.166.0 to a guarded temporary directory, resolves that installation's native executable and runs `--version` plus `app-server proxy --help`. It starts no daemon, authenticates no account and makes no model request. This checks installation/command compatibility, not a complete real-daemon/Telegram exchange on macOS/Linux.
