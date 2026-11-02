# Security

## Trust model

This program runs on the same computer and account as Codex. Telegram is a remote control channel, not a new sandbox. Anyone controlling the paired Telegram account can instruct the selected native sessions within their existing permissions. Enable Telegram two-step verification and protect the local account.

- Only one numeric owner ID in its matching private chat is accepted. Groups and other senders are rejected before journaling or creating per-sender work.
- Projects must be selected locally. Paths are resolved before containment checks.
- The relay supplies no sandbox, network, approval-policy, model, instruction or working-directory overrides to native resume/start/steer calls.
- Approvals require an explicit pending native request. Host async questions use normal native user input, never fabricated approval responses. Current root containment is rechecked before answering; resolution, duplicate clicks and cross-topic clicks invalidate/reject controls.
- Topic recovery commands accept only the paired owner, reject occupied topics and ignored/out-of-root sessions, and never submit native input. Unknown creation results require owner-directed binding or retry; they are not automatically replayed. Recovered topics retire old pending approval controls.
- Remote native settings, direct shell execution and automatic filesystem artifact discovery are absent. Owner-uploaded files are downloaded only after attachment/root checks. Downloads pin the official HTTPS host, reject redirects and traversal, cap streamed bytes, and never expose token URLs to Codex. Files use exclusive random cache paths and are never automatically executed or unpacked.
- Windows requires a native executable; `.cmd` and `.bat` wrappers are rejected.
- Bot tokens stay outside the repository, are not passed on the command line, are stripped from Telegram error text, and Telegram-token environment variables are removed from native child processes.
- Configuration uses owner-only POSIX modes; setup and start replace Windows access rules on the private directory, known state/credential files and downloaded attachments with verified current-user grants, removing broad explicit grants too. Local administrators can still access local data. Encrypted storage is not provided.

## Delivery and approvals

Timeouts do not prove that an operation failed. The relay records uncertain native writes and outgoing messages and does not blindly replay them. A stale button is not an authorization for another request. After an outage, inspect the native terminal before retrying an instruction.

Approvals that existed before attachment may not be replayed by Codex. Some native requests may be routed only to another owning client. Those requests must be answered in the terminal; the relay never auto-accepts them to compensate. Large/unsupported request payloads require the terminal. Telegram messages are cloud messages, not secret chats: do not answer sensitive/password questions there.

State stores delivery text and topic metadata, so protect backups like credentials. Successfully handled records are pruned after seven days. Uncertain records remain for inspection. Incoming attachments use a private 200 MiB cache, with seven-day expiry cleaned at the next upload. Files may remain referenced in the native transcript after expiry; backups and Telegram copies are outside this retention policy. Image decoding is delegated to native Codex. Audio/video transcription is not performed. Host-question journal inspection uses bounded buffers and is restricted to the native sessions directory; known unanswered questions retain their recovery start across reconnects. Partial answer drafts are stored privately for up to seven days and require matching stable request/question identities. Interrupted host-answer reservations become uncertain on startup and never authorize replay. Unrelated tool output and internal reasoning are not forwarded.

User-selected project code and Codex tools remain subject to the native harness's security model.

## Reporting

Do not put tokens, private conversations, real session histories or private filesystem contents in GitHub issues. Share the relay version, Codex version, OS and affected code paths. Use GitHub private vulnerability reporting if available. Otherwise, open a minimal issue requesting a private contact route, without credentials, exploit details or user data. Coordinate a fix before publishing sensitive evidence. No automatic vulnerability-report publishing is implemented.
