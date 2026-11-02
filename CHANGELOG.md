# Changelog

## 0.1.10

- Fix false recovery-window warnings after restart and subsequent user turns: journal size was incorrectly treated as missing question history.
- Stream session journals in bounded chunks instead of truncating recovery to their last 8 MiB. Recover current-turn questions before large tool outputs and apply later answer records before displaying controls.

## 0.1.9

- Remove status topic naming and keep stable project/ID names; migrate the old setting without losing bindings/history.
- Recover host async questions omitted by native App Server, with topic-scoped buttons/text answers and terminal notices for unsupported/sensitive formats. Host answers use normal native user input.
- Receive owner attachments through bounded official Telegram downloads into a private cache. Pass JPEG/PNG/WebP as native images, other files as paths with bounded UTF-8 excerpts. Audio/video are saved without automatic transcription or frame extraction.
- Recheck current native project roots before answering approval/question controls. Forward informative partial answers in all-message mode. Bound JSON response reads while streaming.

## 0.1.8

- Add owner-only `/topics status|simple` selection, defaulting to the existing project/ID format. Status mode uses only the project and a short status.
- Rename existing topics by their saved Telegram IDs, persist confirmed names and apply backoff on rename errors/rate limits. Reconnects and duplicate visible names preserve session routing.
- Read native waiting flags so approval/input waits appear as `ждёт`.
- Resolve executable symlinks on Unix and locate native Codex behind npm launchers, including hoisted/nested platform packages and older vendor layouts. Validate native format and Unix executable permissions without running script wrappers.
- Add CI checks that install official Codex 0.166.0 and run its native version/proxy help commands without starting a daemon or model.

## 0.1.7

- Isolate unavailable-session metadata, resume and history failures so healthy sessions remain connected; transport failures still reconnect normally.
- Journal topic creation before the Telegram request. Unconfirmed creation survives restart and is never automatically repeated.
- Add owner-only `/bind ID` to adopt an already created topic and `/repair ID` to explicitly retry failed or uncertain creation; rate-limit responses honour `retry_after`.
- Recreate deleted topics for loaded sessions and move blocked undelivered answers to the replacement without repeating Codex instructions. Retire old approval buttons before reattachment.
- Prefix every outgoing message part with an italic project signature such as `» tgmcp`; retain project context in notices outside topics and migrate existing queues.

## 0.1.6

- Deliver all assistant commentary and final answers by default, while excluding command output, file/tool events and internal reasoning items.
- Add persistent owner-only `/mode all|compact` selection that applies immediately to future messages across sessions.
- Deduplicate assistant commentary by native item identity across reconnects and render its Markdown.
- Display localhost/private preview links as text instead of invalid Telegram text-link entities.
- Recover from definite Telegram entity rejection using plain text for only the rejected chunk, preserving link targets and already accepted parts.

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
