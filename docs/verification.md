# Verification record

Initial local qualification: 2026-11-02, Windows, Node.js 22.21.1, Codex CLI/shared daemon 0.166.0.

## Automated

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

## Still required before calling a real installation accepted

- Configure a dedicated BotFather bot with private topics and complete owner pairing.
- Confirm topic creation, final delivery, questions and approvals in an actual Telegram client.
- Confirm behaviour after the local computer sleeps and reconnects.
- Verify actual account-specific native approval modes, including any managed or automatic reviewer policies.

No real Telegram exchange, password prompt, file transfer or production deployment is claimed by the synthetic tests or the native-adapter checks.
