# Changelog

## 0.1.5

- Replace canned acceptance messages with the assistant's actual first response to Telegram input, followed by the final answer.
- Suppress later progress chatter and commentary from unrelated background turns.
- Persist reply waits across reconnects and correlate them with the Telegram update and native turn, including responses racing the RPC result.
- Apply Markdown rendering to initial assistant replies as well as completed answers.

## 0.1.4

- Add local `sessions ignore ID` and `sessions unignore ID` commands with unambiguous ID-prefix matching.
- Ignored sessions are excluded from native attachment, input forwarding and queued Telegram delivery after restarting the relay.
- Preserve existing topic bindings, Telegram history and native Codex state; configuration-only updates do not rewrite the bot token.

## 0.1.3

- Present structured native questions with numbered choices, descriptions, concise inline buttons and progress across multiple questions.
- Keep the free-text answer path alongside buttons; reject stale, foreign-user and wrong-topic callbacks.
- Leave secret, oversized, ambiguous or unsupported questions in the terminal instead of displaying incomplete choices.
- Document the distinction between structured native questions and questions written in ordinary assistant prose.

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
