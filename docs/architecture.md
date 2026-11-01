# Architecture and compatibility

## Modules

- `codex.ts`: native executable, raw proxy WebSocket handshake, JSON-RPC correlation, pending-request lifecycle and native session discovery. The transport never falls back to a new daemon and never shells out through cmd.exe.
- `bridge.ts`: project/topic bindings, owner authentication, completion filtering, input routing, questions and explicit one-time approvals. It does not own native sandbox policy.
- `telegram.ts`: fixed official HTTPS endpoint, bounded messages, request timeouts, outgoing throttling and a durable outbox consumer.
- `state.ts`: SQLite bindings, update IDs, delivery status and a local singleton lock. Unknown users' payloads are not stored.
- `config.ts` / `cli.ts`: local pairing, secret input, project selection, user-profile state and process lifecycle.

Native I/O and Telegram I/O have real adapters and test adapters. Most behaviour is exercised through Bridge's request/event/update interface; a separate integration fixture tests actual WebSocket-over-pipes framing.

## Native sessions

The relay asks the existing daemon for loaded thread IDs, reads metadata and selects root interactive sessions (`cli`, `vscode`, `appServer`). Subagents, ephemeral contexts and not-yet-materialized sessions are excluded. Only locally selected project roots are eligible.

Attachment calls `thread/resume` with only `threadId` and `excludeTurns`. A Telegram instruction calls `turn/start` with only its thread ID and text, or `turn/steer` with the expected active turn ID. This intentionally inherits native policy. A rejected or ambiguous steer is never reinterpreted as permission to start another turn.

On first attachment, existing completed history is used only as a baseline. It is not posted to Telegram. Reconnection catches up at most the ten most recent turns for each saved binding. A long outage can therefore leave older missed completions available only in the native terminal. This is a bounded recovery window, not a full transcript mirror.

## Telegram identity and topics

Setup checks getMe/private topics and refuses existing webhooks. It accepts a private `/start RANDOM_CODE` generated locally and saves the sender's ID. Runtime requires the same sender ID and private chat ID. One session maps to one topic, with a session-ID suffix to distinguish parallel sessions in the same directory.

One process consumes getUpdates. The owner check happens before creating work or journaling an input. Input IDs and the polling offset are durable. A crash between sending a native request and receiving acknowledgement is marked uncertain; it is not replayed. There is no exactly-once guarantee across Telegram and native Codex.

Completed agent messages are buffered until turn completion; commentary is omitted. Native questions and approvals carry unguessable, topic-scoped callback capabilities. Multi-question prompts rotate capabilities so an old answer button cannot answer a later question. Unknown request types and payloads too large to review completely are left to the terminal.

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
