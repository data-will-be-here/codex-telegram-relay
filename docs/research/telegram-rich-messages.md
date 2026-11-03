# Telegram rich messages

Research date: 2026-11-02. Official documentation only. No bot messages, native model turns or implementation changes were used for this research.

Implementation follow-up: the initial table/heading integration is included in 0.1.13. See [architecture](../architecture.md) and [verification](../verification.md). The local-code findings below describe the pre-integration snapshot; rich deliveries now have durable per-part progress. Research notes remain source-only and are excluded from the installable package.

## Confirmed API contract

- [`sendRichMessage`](https://core.telegram.org/bots/api#sendrichmessage): private-topic routing and existing keyboards supported; no Premium prerequisite listed. Leave optional paid broadcast unset.
- [`InputRichMessage`](https://core.telegram.org/bots/api#inputrichmessage): choose `blocks`, `markdown` or `html`.
- [`Table`](https://core.telegram.org/bots/api#inputrichblocktable) / [`cells`](https://core.telegram.org/bots/api#richblocktablecell): compact styling, headers, alignment, spans.
- [Limits](https://core.telegram.org/bots/api#rich-message-limits): 32768 UTF-8 characters, 500 blocks, depth 16, 50 media, 20 columns.
- [`Details`](https://core.telegram.org/bots/api#inputrichblockdetails): expandable blocks.
- [`Buttons`](https://core.telegram.org/bots/api#richmessagebutton): callback data 1–64 bytes; [rows](https://core.telegram.org/bots/api#inputrichblockbuttons) 1–8 buttons.
- [`Drafts`](https://core.telegram.org/bots/api#sendrichmessagedraft): 30-second previews; final `sendRichMessage` required.

## What this can improve

Telegram describes rich messages as suitable for reports and AI answers, with native tables, headings, lists, quotations, collapsible details, formulas, footnotes and embedded controls. Regular messages remain appropriate for short confirmations. Rich Markdown follows GFM where possible and can interpret supported HTML, so forwarding model output unchanged would introduce behavior beyond our current renderer. [Official feature overview](https://core.telegram.org/bots/features#rich-messages).

The screenshot's pipe-delimited code block follows our current implementation: `src/format.ts:93` renders a Markdown table's raw source as `pre`; `src/telegram.ts` sends ordinary `sendMessage` text/entities with roughly 3500 UTF-16-unit chunks minus the project signature. `State.enqueue` also truncates text above 40000 UTF-16 units before formatting, so larger rich-message limits alone would not remove that upstream truncation. Changing `parse_mode` cannot enable the separate rich-message API. These are local code findings, not Telegram documentation claims.

## Recommendations for this relay (engineering judgement)

1. Convert the existing parsed Markdown into an explicit, allowlisted rich-block document. Start with assistant replies containing tables, retaining the italic project signature and surrounding paragraphs. Table headers become header cells; preserve inline formatting through structured RichText. Keep short notices on the existing path.
2. Use native tables for compact comparisons. For prose-heavy mobile tables like the screenshot, offer a readable row-card layout as a deliberate alternative; compact cells only reduce padding and cannot guarantee a comfortable phone layout. Do not delete or summarize cell contents automatically.
3. Retain current inline approval/question keyboards initially. Moving them inside rich blocks is optional and must retain owner/topic/request validation and one-shot callbacks. Commands and requested permissions must remain visible before an approval; collapsible blocks must not conceal the decision-critical payload.
4. Split at block/row boundaries under explicit budgets, repeating table headers after row splits. Unsupported/wide tables can use complete row cards instead of pipe-delimited code. Do not reuse the current arbitrary character splitter for structured JSON. Persist delivery intent and method/payload choice before network writes; add durable per-part acceptance records if multipart resume is introduced. The existing outbox stores delivery-level state rather than a durable ledger for each part.
5. Fall back to a row-card/plain representation only before sending, or after an unambiguous rejection of that unsent payload. An unknown send outcome must not automatically trigger `sendMessage`, which could duplicate a message that Telegram already accepted.
6. Keep raw HTML literal. Do not automatically fetch model-supplied media URLs or read/upload local links; rich media must be a separately authorized feature. Preserve existing safe link handling. Rich "thinking" blocks do not authorize forwarding internal reasoning. Draft streaming can be a later feature, separate from durable delivery.

## Unknowns requiring acceptance checks

- The reviewed docs do not establish a minimum supported Telegram client version, a recipient-capability negotiation mechanism, or a guaranteed unsupported-client fallback. Check actual current Desktop/Android/iOS presentation before promising compatibility.
- No live check was performed with this bot: confirm private-topic routing, native table layout, Unicode/code preservation, long-table splitting and one-shot controls in a disposable test exchange when implementation is authorized.
- The documentation says “UTF-8 characters”; validate actual boundary behavior conservatively rather than assuming JavaScript UTF-16 length or byte count is the normative limit.
