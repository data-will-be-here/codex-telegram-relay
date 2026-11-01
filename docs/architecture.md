# Architecture and compatibility

## Modules

- `codex.ts`: native executable, raw proxy WebSocket handshake, JSON-RPC correlation, pending-request lifecycle and native session discovery. The transport never falls back to a new daemon and never shells out through cmd.exe.
- `bridge.ts`: project/topic bindings, owner authentication, completion filtering, input routing, questions and explicit one-time approvals. It does not own native sandbox policy.
- `telegram.ts`: fixed official HTTPS endpoint, bounded messages, request timeouts, outgoing throttling and a durable outbox consumer.
- `format.ts`: CommonMark/GFM parsing into Telegram text entities, safe external links and UTF-16-aware splitting. Raw HTML is displayed literally; code never nests inside formatting entities.
- `state.ts`: SQLite bindings, update IDs, delivery status and a local singleton lock. Unknown users' payloads are not stored.
- `config.ts` / `cli.ts`: local pairing, secret input, project selection, user-profile state and process lifecycle.

Native I/O and Telegram I/O have real adapters and test adapters. Most behaviour is exercised through Bridge's request/event/update interface; a separate integration fixture tests actual WebSocket-over-pipes framing.

## Native sessions

The relay asks the existing daemon for loaded thread IDs, reads metadata and selects root interactive sessions (`cli`, `vscode`, `appServer`). Subagents, ephemeral contexts and not-yet-materialized sessions are excluded. Only locally selected project roots are eligible.

Attachment calls `thread/resume` with only `threadId` and `excludeTurns`. A Telegram instruction calls `turn/start` with only its thread ID and text, or `turn/steer` with the expected active turn ID. This intentionally inherits native policy. A rejected or ambiguous steer is never reinterpreted as permission to start another turn.

On first attachment, existing completed history is used only as a baseline. It is not posted to Telegram. History requests use display summaries, excluding large historical tool outputs. Reconnection catches up at most the ten most recent turns for each saved binding. A long outage can therefore leave older missed completions available only in the native terminal. This is a bounded recovery window, not a full transcript mirror.

## Telegram identity and topics

Setup checks getMe/private topics and refuses existing webhooks. It accepts a private `/start RANDOM_CODE` generated locally and saves the sender's ID. Runtime requires the same sender ID and private chat ID. One session maps to one topic, with a session-ID suffix to distinguish parallel sessions in the same directory.

One process consumes getUpdates. The owner check happens before creating work or journaling an input. Input IDs and the polling offset are durable. A crash between sending a native request and receiving acknowledgement is marked uncertain; it is not replayed. There is no exactly-once guarantee across Telegram and native Codex.

Final agent answers are buffered until turn completion. In the default `all` mode, each completed assistant commentary message is delivered and deduplicated by native thread/turn/item identity. In `compact` mode, only the first commentary reply after Telegram input is delivered; later commentary and background-session commentary are omitted. Tool/file/command events and internal reasoning items are never mirrored. The owner can change this durable global preference with `/mode all|compact`; it affects future messages immediately and does not import previously skipped history. Native questions and approvals carry unguessable, topic-scoped callback capabilities. Multi-question prompts rotate capabilities so an old answer button cannot answer a later question. Unknown request types and payloads too large to review completely are left to the terminal. Terminal-only attention notices use persistent native identity and do not repeat for the same request across reconnects. Attaching to a waiting session alone does not emit another warning.

Interactive question cards require the native `item/tool/requestUserInput` request. Each question lists numbered options with full descriptions, one button per option, and a free-text alternative. Multiple questions are answered sequentially using their original native IDs. At most ten questions with unique IDs, ten choices per question and 18,000 serialized characters per question are supported; secret or unsupported questions stay in Codex. Ordinary assistant prose, including questions from tools that do not emit this native request, is not classified into buttons.

The local `sessions ignore/unignore` commands resolve an exact ID or a unique prefix against stored bindings using a read-only database connection. They update only local `ignoredThreadIds` preferences; the token file is not rewritten. After restart, ignored sessions are never resumed and their pending topic deliveries are cancelled without sending or changing native requests. Existing bindings/history remain for re-enabling. Closing a terminal window does not reliably remove a daemon-loaded thread, so there is no automatic Telegram topic closure or deletion.

Instructions (including steering), completed question answers and approval decisions durably record that an assistant reply is awaited before writing to Codex. This captures replies arriving before the RPC result. The first commentary message in the matching turn is queued once per Telegram update, then the wait is consumed. Questions and final answers also consume the wait. Failed writes clear it, and a reconnect preserves it without replaying commentary already delivered. No canned acceptance/decision/answer messages substitute for the assistant's words. If Codex emits no initial commentary, the next visible response is its question or final answer.

Assistant messages are rendered with explicit Telegram entities instead of `parse_mode`: CommonMark differs from Telegram MarkdownV2. Entities use UTF-16 offsets and are clipped/rebased for each message. Formatting is bounded to 100 entities per chunk without removing text. Native approval payloads and questions stay verbatim so Markdown does not conceal command or diff characters. Local file and local/private preview URLs retain their label and target as text because Telegram can reject localhost text-link entities. A definite HTTP 400 entity error retries only that rejected chunk without entities, retaining link targets and re-splitting if necessary; accepted chunks are never replayed. Network ambiguity, missing-topic errors and other failures do not trigger this fallback.

## Initial release limits

- Native compatibility is targeted at Codex CLI 0.166.0. App Server remains an evolving protocol. Unsupported versions should fail without spawning a replacement harness.
- No MCP server is needed to use the relay. Future MCP registration can be an optional adapter; it is not the core execution interface.
- There is no real Telegram bot exchange in automated tests. BotFather settings, user pairing and actual mobile/desktop topic UI require a live acceptance pass.
- Existing approvals from before attachment, connector elicitations, native approval routing between clients and reconnect replay depend on Codex behaviour. Use the terminal whenever the request cannot be safely identified/displayed by this client.
- No attachments, audio decoding, arbitrary file reading, new-thread creation, server deployment or auto-start installation.
- Native settings are inherited. The relay does not enforce a stronger sandbox than the native owner selected.
- Slow/failed Telegram deliveries are not an excuse to repeat a native instruction. Outgoing ambiguity is visible in `/status`; inspect the terminal and local state before retrying.

## Verification

`npm test` uses synthetic projects, an in-process Telegram adapter, temporary SQLite stores and an actual HTTP/WebSocket peer behind a subprocess's stdio. It does not read user conversations, start live model turns or use credentials.

`doctor` is read-only: initialize, list loaded threads and read metadata, plus getMe/getWebhookInfo if configured. It never resumes a thread, starts a model turn or changes Codex settings.

Sources: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [developer commands](https://learn.chatgpt.com/docs/developer-commands), [Telegram Bot API](https://core.telegram.org/bots/api), [ws](https://github.com/websockets/ws).
