# Security

## Trust model

This program runs on the same computer and account as Codex. Telegram is a remote control channel, not a new sandbox. Anyone controlling the paired Telegram account can instruct the selected native sessions within their existing permissions. Enable Telegram two-step verification and protect the local account.

- Only one numeric owner ID in its matching private chat is accepted. Groups and other senders are rejected before journaling or creating per-sender work.
- Projects must be selected locally. Paths are resolved before containment checks.
- The relay supplies no sandbox, network, approval-policy, model, instruction or working-directory overrides to native resume/start/steer calls.
- Only explicit pending native requests can be answered. Native resolution, duplicate clicks and cross-topic clicks invalidate/reject controls.
- Remote setting changes, shell commands, file uploads and automatic filesystem artifact discovery are absent.
- Windows requires a native executable; `.cmd` and `.bat` wrappers are rejected.
- Bot tokens stay outside the repository, are not passed on the command line, are stripped from Telegram error text, and Telegram-token environment variables are removed from native child processes.
- Configuration uses owner-only POSIX modes; setup restricts inheritance on its Windows directory. Local administrators can still access local data. Encrypted storage is not provided.

## Delivery and approvals

Timeouts do not prove that an operation failed. The relay records uncertain native writes and outgoing messages and does not blindly replay them. A stale button is not an authorization for another request. After an outage, inspect the native terminal before retrying an instruction.

Approvals that existed before attachment may not be replayed by Codex. Some native requests may be routed only to another owning client. Those requests must be answered in the terminal; the relay never auto-accepts them to compensate. Large/unsupported request payloads require the terminal. Telegram messages are cloud messages, not secret chats: do not answer sensitive/password questions there.

State stores delivery text and topic metadata, so protect backups like credentials. Successfully handled records are pruned after seven days. Uncertain records remain for inspection. User-selected project code and Codex tools remain subject to the native harness's security model.

## Reporting

Do not put tokens, private conversations, real session histories or private filesystem contents in GitHub issues. Share the relay version, Codex version, OS, a synthetic reproduction and the affected code paths. While the repository is private, coordinate a fix with the maintainer before disclosing details outside its collaborators. No automatic vulnerability-report publishing is implemented.
