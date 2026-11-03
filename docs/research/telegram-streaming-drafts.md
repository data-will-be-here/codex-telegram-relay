# Streaming ordinary and rich Telegram drafts

Research date: 2026-11-03. Official Telegram sources and local source inspection only. No live bot calls, model turns, credentials or runtime changes were used. Local snapshot: `0fbf1c307355ed8196607906556354c44258179c`.

Implementation follow-up: version 0.1.14 follows the rich-preview recommendation below. Subsequent synthetic Telegram API, isolated native-stream and owner visual checks are recorded separately in [verification](../verification.md). The local findings below describe the pre-implementation snapshot.

## Confirmed contracts

- [`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft) accepts text/entities up to 4096 characters; [`sendRichMessageDraft`](https://core.telegram.org/bots/api#sendrichmessagedraft) accepts an `InputRichMessage`. Both target a private chat, optionally its topic, using a nonzero `draft_id`. Repeated IDs animate updates. Previews expire after 30 seconds; completed results require a separate persistent send. Rich drafts cannot upload new files directly or explicitly by URL.
- [`InputRichMessage`](https://core.telegram.org/bots/api#inputrichmessage) takes exactly one of `blocks`, `markdown` or `html`. Paragraph-only rich documents are valid. [Rich limits](https://core.telegram.org/bots/api#rich-message-limits): 32768 UTF-8 characters, 500 blocks, depth 16, 50 media, 20 table columns. [Rich Markdown](https://core.telegram.org/bots/api#rich-markdown-style) also interprets supported HTML; forwarding untrusted Markdown unchanged expands behavior beyond the relay's current allowlist.
- Telegram describes [ordinary or rich drafts followed by `sendMessage` or `sendRichMessage`](https://core.telegram.org/bots/features#streaming-replies). The preview is not a persistent message that needs editing into another message type. Regular messages remain lighter and support interactions such as partial quotes that rich messages lack. [Formatting comparison](https://core.telegram.org/bots/features#messages-and-formatting).
- [Live draft lifecycle](https://core.telegram.org/api/bots/ai#live-response-streaming): identity includes chat, topic and draft ID. New permanent messages in that topic clear the preview. Limits are 20 calls per five seconds and 40 per 30 seconds, shared by the private chat across its topics; respect server cooldowns. Not every client renders multiple drafts concurrently in one topic. Use one active preview per topic.

## Local source findings

`src/codex.ts` currently opts out of assistant text deltas. `src/bridge.ts` forwards completed public assistant messages according to all/compact mode and enqueues final answers durably. Tools and internal reasoning are excluded.

`src/rich.ts` already parses GFM locally into allowlisted explicit blocks, treats raw HTML literally, checks links, adds the italic project signature, and splits under conservative object/byte budgets. Its current `structured()` gate returns no rich representation for simple paragraphs. `src/telegram.ts` chooses rich final delivery for headings/tables and retains safe ordinary fallback; accepted rich parts have durable progress.

## Recommendation: rich previews for public assistant text

Engineering judgement, not an additional API guarantee:

1. Use `sendRichMessageDraft` for every eligible assistant preview from its first paragraph. Reuse the safe renderer with an explicit preview path that also accepts simple prose. A paragraph can grow into a document containing a table without switching draft methods. This does not mean moving approval or question controls into transient drafts, or streaming hidden reasoning.
2. Send a complete valid block snapshot on each batched update. Never send partial JSON. Keep unfinished Markdown constructs literal until enough structure exists to render them safely; complete table rows can become native rows while the current row is still arriving. Changes in layout while syntax becomes recognizable are possible even if every preview uses rich format.
3. Preserve the current durable final delivery decision: short ordinary responses can remain ordinary; structured responses become permanent rich messages. Stop previews before final sending, including drafts already in flight, so a late update cannot recreate a preview after completion. Draft failures must not suppress the final answer or block questions.
4. Coalesce deltas in bounded memory and update at roughly one call per second for the owner chat, with fair scheduling across topics. Parse only at flush time. Bound the displayed preview separately from the complete final result. Long answers may have a visible preview tail; never silently truncate their durable final because the preview is bounded.
5. On a definite unsupported rich-draft method, use ordinary text previews; on a transient draft error, back off. Draft fallback is not authorization to replay uncertain permanent sends. Keep streaming configurable and apply existing owner/scope and all/compact policies.

The benefit is a consistent preview path and native structure as it becomes available. Costs are larger payloads, repeated parsing and more renderer/lifecycle testing. Rich does not eliminate rate limits or unfinished syntax. Converting every permanent notice/control to rich is unnecessary scope and changes existing interactions.

## Acceptance gaps

The reviewed docs do not guarantee how every incomplete Markdown prefix is parsed, cross-format replacement animation, minimum client versions, or capability negotiation. Test current Android/Desktop/iOS presentation, ordinary-preview to rich-final replacement, rich-preview to ordinary-final replacement, interrupted generation, 30-second pauses, unsupported methods, long tables, and simultaneous topics. Exact latency is unmeasured. Treat the published live-draft quota conservatively as one shared budget for both draft methods; the AI page names text drafts explicitly rather than providing a separate rich quota.
