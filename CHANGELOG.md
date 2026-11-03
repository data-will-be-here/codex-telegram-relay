# Changelog

## Unreleased

- Add locally enabled outgoing project files through `send-file`, using the running relay's paired bot and exact session topic without exposing its token to the producer command. MP4 uploads as video; other files and forced-original media upload as documents.
- Bound and snapshot files, reserve queue capacity transactionally across simultaneous producers, recheck live sessions and local revocation, and keep large network uploads independent of assistant output and questions.
- Persist delivery receipts and idempotent request IDs. Interrupted/ambiguous uploads remain uncertain with no automatic replay; expose them in `/status` and local `files status`. Document opt-in, usage, limits and the trusted remote-control security model in both languages.

## 0.1.16 — 2026-11-03

- Explain the trusted remote-control security model before pairing and in both READMEs. Recommend Telegram Two-Step Verification, app/device locks, auto-lock, protected recovery email and active-session review, distinguishing new-login protection from existing-session access.
- Document operator responsibilities and practical local shutdown limits without adding acknowledgement gates or changing owner checks, native permissions or approvals.
- Require installation agents to explain account security to the user for both bare repository URLs and copied installation prompts, including already-paired installations. Keep session-scope consent separate and leave account security settings under the user's control.

## 0.1.15 — 2026-11-03

- Register the connected bot's command menu during setup/start, using owner-chat scope, English fallback and Russian descriptions. Share the catalog with `/help`, skip unchanged lists and isolate menu errors from relay delivery; diagnostics remain read-only.
- Show usage when `/say` is selected without arguments. Preserve owner/private-chat authorization for every command, including manual commands sent by strangers who cannot see the menu.

## 0.1.14 — 2026-11-03

- Stream public assistant answers through native Telegram rich drafts, including simple prose and tables, without forwarding command output or private reasoning. Keep all/compact filtering and add persisted owner-only `/stream on|off` controls.
- Coalesce token bursts outside the control-event queue, fairly share one chat-wide preview budget and recheck native session scope before sending. Keep bounded previews separate from complete durable answers; preview failures do not suppress final delivery or repeat instructions.
- Prioritize permanent output, settle in-flight preview calls before final sends, honor cooldowns and fall back to ordinary previews after a definite rich-draft rejection. Preserve existing final formatting, multipart recovery and the 40,000-unit source-text safety limit.

## 0.1.13 — 2026-11-03

- Automatically send assistant replies containing Markdown tables or headings with Telegram rich blocks. Preserve surrounding text, inline styling, code, safe links and italic project signatures; keep short replies and approval controls on ordinary messages.
- Split large rich answers at block/table-row boundaries with repeated headers. Use complete labelled paragraphs for tables wider than 20 columns or oversized rows; after a definite rich-format rejection, fall back to readable text cards rather than raw table markup.
- Persist rich delivery plans and accepted-part progress across topic recovery and relay restarts. Unknown send outcomes are never retried or switched to another method. Exclude research notes from the distributable package.

- Replace raw command-approval JSON with reason, working directory and a literal command block. Omit transport IDs and duplicate parsed actions while retaining additional permission/security context.
- Render approval cards with escaped dynamic text and command/diff code blocks, preserving exact command characters and placing buttons after the final message part. Approval validation, one-shot owner callbacks and oversized-request terminal fallback remain unchanged.
- Display commands containing carriage returns or invisible C0/DEL controls as labelled JSON strings, avoiding Markdown newline normalization while preserving the native request unchanged.
- Publish the English landscape demonstration and feature highlights in both READMEs, with reproducible installation pinned to v0.1.13.

## 0.1.12

- Add explicit local automatic discovery with `sessions scope all` or `setup --scope all`, including future projects without repeated setup. Preserve selected-project defaults and ignored-session/subagent exclusions.
- Apply session scope consistently to discovery, input, outgoing events, approval controls and topic recovery. Show discovery mode at startup, in `/status` and in read-only `doctor` eligibility diagnostics.
- Add agent-assisted installation prompts and workflows in both READMEs: read release documentation from main, install the version tag, explain session scopes and wait for the owner's choice before configuring them.

## 0.1.11

- Remove pre-existing broad Windows ACLs from private directories and credential/state/cache files; verify current-user grants at setup/start without changing audit policy.
- Report oversized/capacity-limited host questions instead of silently dropping them. Preserve known unanswered questions across later turns/reconnects and exclude locally answered forms from reader capacity.
- Persist partial question drafts using stable request identity and content fingerprints.
- Track sending/accepted/uncertain host-answer attempts durably; definite rejections remain retryable and uncertain writes are not replayed.
- Rediscover a missing Codex executable or accept an explicit start --codex-bin override. Save a replacement only after a successful daemon protocol check, preserving pairing and topics; doctor stays read-only.

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
