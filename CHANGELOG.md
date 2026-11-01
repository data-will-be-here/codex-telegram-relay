# Changelog

## 0.1.2

- Render completed Markdown answers using Telegram entities, including emphasis, links and code with Unicode-safe splitting.
- Preserve raw approval/question payloads and display local file-link targets as text.
- Confirm accepted Telegram instructions, question answers and approval decisions in their own topic, without forwarding commentary.
- Clarify that daemon-loaded threads can include older sessions whose terminal/IDE window is no longer visible.
- Add regression coverage for acknowledgement, nested formatting, long Unicode/code/link output, unsafe URLs and malformed Markdown.

## 0.1.1

- Read display summaries instead of full historical tool output. A large stored tool result no longer disconnects session discovery at the WebSocket payload limit.
- Deduplicate terminal-only attention notices by native thread/turn/item across reconnects, rather than by transport request IDs.
- Do not treat attachment to an already waiting session as a new approval notification.
- Report an oversized protocol response as a payload error instead of incorrectly saying that the Codex daemon is stopped.
- Add regression tests for large history, unchanged background approvals across reconnects, and transport diagnostics.

## 0.1.0

Initial developer version: private Telegram topics for existing Codex sessions, immediate steering, native questions and one-time approvals, owner pairing, local SQLite state, and cross-platform CI.
