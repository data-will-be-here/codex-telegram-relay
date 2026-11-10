# Private Telegram topics: BOT_TOPIC_WRONG_HOME and Hermes PR #1206

Checked: **2026-11-09, 20:15 UTC**. Research only: public primary sources and the pinned PR diff/tests; no calls to our bot, credentials, native sessions, or live Telegram acceptance tests.

## Conclusion

The reports in [Telegram Bot API issue #944](https://github.com/tdlib/telegram-bot-api/issues/944) match the observed combination: new private topics fail with `BOT_TOPIC_WRONG_HOME`, creation notices or apparent topics can still appear, those new IDs reject messages, and older topics continue working. Independent reproductions strongly indicate a Telegram backend regression. **This is an inference from first-hand reproductions, not a maintainer-confirmed internal root cause.** At the checked snapshot the issue is open, with no maintainer explanation, verified repair procedure, or ETA.

[Hermes PR #1206](https://github.com/0xble/hermes-agent/pull/1206) mitigates the outage and makes delivery accounting more truthful. It does **not** make Telegram create usable topics, restore deleted topic IDs, or fix the separate historical threadless-opener routing bug. Waiting 15 minutes is its chosen cooldown policy, not a promise that Telegram recovers in 15 minutes.

## What the upstream evidence establishes

| Evidence | Practical meaning | Primary source |
| --- | --- | --- |
| Raw cloud Bot API requests reproduce the error on several bots, including a newly created bot, while topic flags are enabled. | This is not specific to our relay or the Hermes adapter. | [Cloud reproduction](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6745548526), [minimal request without icon parameters](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6747493379) |
| The original reporter reproduced the same failure after reverting the local Bot API server from 10.4 to 10.3. | A local server downgrade is not a demonstrated workaround. | [Version rollback experiment](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6745876184) |
| An independent reporter reproduced `BOT_TOPIC_WRONG_HOME` with the user's own MTProto `messages.createForumTopic`, too. | Switching only the bot library or transport is not a demonstrated escape. | [MTProto and deleted-topic readback](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6748498202) |
| Every refused creation in that reproduction emitted `forum_topic_created`; user-side readback returned `forumTopicDeleted`. Three refused calls left three deleted IDs. | **HTTP 400 does not prove absence of side effects.** Automatic creation retries can leave more dead entries. | [Direct ghost-topic evidence](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6748498202) |
| A creation notice can appear despite the API error; fresh user-created topics can dissolve, and opening messages can arrive without a thread ID. | A title, service message, or apparent topic is not proof of a usable conversation. | [Notice despite error](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6746532717), [Android and MTProto readback](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6746056053) |
| `sendChatAction` reportedly succeeds even for an invalid thread ID. | It cannot certify topic health; successful actual message delivery matters. | [Invalid-ID comparison](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6745645481) |
| The latest checked report sees a topic appear but explicitly has no successful round trip inside it. | That report does not establish recovery. | [19:30 UTC report](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6749388176) |

These reports correct an earlier possible interpretation of a warning-only topic: the failed `createForumTopic` call itself can leave a dead creation/history entry. Its appearance alone cannot establish that a subsequent standalone warning created it. Attribution for any particular local entry would require its exact receipts; the public evidence does not identify local entries.

Restarting clients, toggling Threaded Mode, changing a topic named General, and using a new bot have not restored creation in the cited reproductions. No speculative reset, deletion, token rotation, or repeated creation loop is supported by these sources. [Toggle/client experiment](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6745645481), [new bot](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6747493379), [rename experiment](https://github.com/tdlib/telegram-bot-api/issues/944#issuecomment-6748498202).

## Exactly what Hermes PR #1206 changes

Snapshot: **open, draft, not merged**, 14 changed files, +439/-61. Head: `fdc906903804a5a50cccd0db0c783e184c02fb04`. Two commits: [a58ec840 — explain/throttle creation outages](https://github.com/0xble/hermes-agent/commit/a58ec84022682b74e6ad912f71a70ce7f3827814), [fdc90690 — preserve root fallback in delivery outcomes](https://github.com/0xble/hermes-agent/commit/fdc906903804a5a50cccd0db0c783e184c02fb04). The [PR page](https://github.com/0xble/hermes-agent/pull/1206) and pinned source below define the examined implementation.

1. **Creation circuit breaker.** `BOT_TOPIC_WRONG_HOME` is classified as a server refusal and produces an actionable, privacy-safe error. It sets an adapter-wide, process-local 900-second cooldown using monotonic time. Subsequent callers/chats are suppressed during that interval. Blocked requests do not extend it; after expiry another attempt may call the API. Restarting/recreating the adapter loses this in-memory cooldown. There is no Telegram `retry_after` instruction establishing this interval. [Pinned implementation](https://github.com/0xble/hermes-agent/blob/fdc906903804a5a50cccd0db0c783e184c02fb04/plugins/platforms/telegram/topic_creation.py).

2. **Delivery destination accounting.** A context-local marker records when an existing send retry path drops the requested thread and delivers to the root chat. Nested and multipart sends preserve the outcome without leaking it into a later independent send. The ledger records `thread_fallback_root` rather than treating root delivery as successful in-topic delivery. This improves reporting of a fallback that already existed; it does not restore the topic. [Fallback tracker](https://github.com/0xble/hermes-agent/blob/fdc906903804a5a50cccd0db0c783e184c02fb04/plugins/platforms/telegram/thread_fallback.py), [delivery ledger](https://github.com/0xble/hermes-agent/blob/fdc906903804a5a50cccd0db0c783e184c02fb04/gateway/delivery_ledger.py).

3. **Regression coverage.** The new outage tests use a fake bot raising the exact error, mock monotonic time, and verify suppression across chats and the 899/900-second boundary. Fallback tests exercise send variants and normal/cancelled/recovered delivery accounting using fakes and a temporary ledger. These tests support the adapter behavior; they cannot prove Telegram's backend is repaired. [Outage tests](https://github.com/0xble/hermes-agent/blob/fdc906903804a5a50cccd0db0c783e184c02fb04/tests/gateway/test_topic_creation_outage.py), [fallback tests](https://github.com/0xble/hermes-agent/blob/fdc906903804a5a50cccd0db0c783e184c02fb04/tests/gateway/test_telegram_thread_fallback.py).

The author reports passing focused and broader tests in the PR description. This research inspected the code/tests but did not run Hermes. At the checked head, the repository's static/Node gate and ten Python/e2e shards were still in progress; the prompt-surface check had passed. No full current-head CI pass, maintainer review, or live Telegram acceptance is asserted here. [Checks](https://github.com/0xble/hermes-agent/pull/1206/checks).

## Separate failures that must not be conflated

- [Hermes #136567](https://github.com/NousResearch/hermes-agent/issues/136567), now closed, describes an earlier **routing** problem: the opening message of an otherwise usable private topic lacked `message_thread_id`, so Hermes selected a previous session. Narrow correlation with a fresh creation event addresses that type of opener routing. It cannot make a server-deleted topic accept messages.
- [Hermes #152148](https://github.com/NousResearch/hermes-agent/issues/152148), open at the snapshot, describes the current fresh-topic invisibility and misleading delivery outcome. Adopting an opener into its new ID did not make the ID writable; a root fallback was still recorded as delivered. This is the accounting problem PR #1206 addresses alongside creation throttling.
- [Telegram Bot API #905](https://github.com/tdlib/telegram-bot-api/issues/905) is an older, open report where creation can return success but subsequent writes fail. It reinforces that a creation receipt alone is insufficient, but it is not evidence that today's `BOT_TOPIC_WRONG_HOME` has a known repair.

## Application to this relay

These are architectural conclusions for the relay, **not changes implemented by this research**:

1. Preserve the topic-first `/new` ordering: do not create a new native session before a confirmed Telegram destination. Keep a stable operation record and surface creation failure instead of leaving the UI indefinitely in Creating.
2. Treat `BOT_TOPIC_WRONG_HOME` as an error with potentially uncertain side effects. Do not automatically replay the same creation, clone native sessions, or trust a later creation service event as a complete recovery receipt.
3. A circuit breaker can reduce duplicate dead entries and repeated warnings. Its expiry permits a deliberate fresh attempt; it does not authorize replay of an uncertain operation or prove the service recovered. The Hermes 15-minute constant is a product choice that needs no imitation as a Telegram guarantee.
4. Preserve exact destination truth: successful root-chat delivery, successful delivery to the bound topic, and a healthy topic are different outcomes. Never let one mark the others successful.
5. **Do not copy automatic root fallback into the relay.** One topic maps to one native session; silently dropping the thread risks mixing sessions. A separate, explicit owner-selected healthy destination can support continuity, with unambiguous binding and no automatic selection of the most recent session.
6. Existing healthy topics provide a limited continuity path. The examined sources offer no verified bot-side procedure to resurrect dead private topic IDs or reliably create a new isolated topic during this incident. Restoring that capability currently depends on Telegram recovery or a future verified upstream workaround.

## Evidence boundary

Only public first-hand issue reports, PR metadata, commits, and pinned source/tests were used. Issue commenters are reporters, not Telegram maintainers; their reproducibility is evidence, while Telegram's internal failure mechanism remains unknown. We did not modify topic settings/history, probe the real bot, or run Hermes tests. Source state can change after the timestamp above.
