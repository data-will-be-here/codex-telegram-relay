# Verification record

## Same-topic /clear and native permission presets

Owner-approved `/clear` starts one empty conversation in the current topic and cwd, preserving Telegram/native history and the previous terminal session. Tests cover duplicate requests, input fencing, active turns and pending approvals, queued deliveries, unknown-create recovery, definite rejection/unlock, scope revocation during metadata reads, a worker racing preflight, delayed handoff, scratch ownership, old-event isolation, historical Full answer reads, rejection of old permission controls, disk recovery and moved-topic lineage rejection. A red regression also proved that a missed completed reply could be lost before replacement; preflight now recovers that reply and waits for its delivery. Wire tests verify that clear creation adds only `sessionStartSource=clear` to the existing minimal creation request; it does not copy model/permission overrides or submit input. No production topic or native conversation was reset for qualification.

`/permissions` now uses the CLI's four complete presets and compares profile/policy/reviewer for the current marker. Catalog/feature/managed gates remain authoritative; custom profiles retain policy/reviewer and Full Access retains confirmation. A real isolated temporary Codex profile exercised Full Access confirmation, Ask for approval and Approve for me through the picker, then verified persistence across restart without model turns or global configuration edits. Independent spec/standards reviews found a pre-creation scope race and a definite-rejection lock; both were fixed with regressions. Final local suite: 367 discovered, 363 passed, four platform/opt-in skips, zero failures; the separately enabled native permissions check passed. Typecheck, package checks and production dependency audit passed.

## Expanded previews and notified final-result widgets

The screenshot's Russian paragraph reproduced a double byte truncation (160 then 128 bytes). Progress now uses the remaining 900-byte JSON budget after metadata and escaping, prefers complete sentences and shows an explicit ellipsis. Local More/Less reveals additional loaded text; Current step retrieves the saved explanation. Widget turns suppress answer drafts and send a separate notified result card with an authenticated Full answer control. The full original reply survives ordinary queue pruning; explicit reads use multipart formatting without the normal 40,000-unit shortening guard. Classic behavior is preserved.

Regression coverage includes long-answer tails, eight-day queue pruning followed by late completion, message/topic/owner rejection, detached-native cached reads, failed callback acknowledgement, definite/pre-connect/unknown result sends, temporary local receipt and outcome write failures, and restarts with known or unknown receipts. A durable fallback marker prevents repeating text fallback after its queue record is pruned. Two independent review axes found truncation, deduplication and persistence-window issues; these were corrected and focused regressions passed.

The official pinned WidgetHost/QuickJS validator and renderer passed 32 cases covering activity/result cards, widths 320/430, light/dark and text sizes 20/24/32/64. More/Less expanded the narrow-screen preview from 125 to 246 characters. Maximum measured height was 497.8px, with no overflow, runtime death or page errors. The preview screenshot was delivered through the standard file queue with a durable sent receipt. This is official sandbox rendering, not physical-client acceptance of the new buttons. Full local suite: 354 discovered, 350 passed, four platform/opt-in skips, zero failures. Clean install, typecheck, package checks, dry-run pack and production dependency audit passed. Topic-outage research made no new live topic-creation requests; see [the primary-source comparison](research/telegram-private-topic-regression-2026-11-09.md).

## Widget progress and terminal rendering

Four red regressions established that widget commentary was neither shown in the card nor suppressed outside it, missed completion events stayed Working until reconnect, summaries without plan/tool rows were hidden, and terminal Last update continued growing. Production-state inspection found two known sent cards already Done with every revision acknowledged, so the user-visible stale footer was not treated as proof of a failed edit.

Fixes keep bounded commentary in the card, add safe action detail, remove captions, poll quiet active cards fairly and recover missed final replies once. Additional regressions cover Classic fallback of suppressed progress, native-poll races, terminal activity cleanup and preserving a newer final baseline. No model task/settings/permission writes are introduced. Existing HTML is immutable; old cards keep their old template.

Official WidgetHost/QuickJS/renderer acceptance passed 16 light/dark cases at 320/430px and 20/24/32/64 text sizes, including summary-only cards and live state changes without restart. The maximum measured height was 395.2px, with no horizontal overflow, runtime death or page errors. A live Working→Done update showed Finished unchanged across subsequent timer ticks. The real renderer initially caught an oversized 64px layout; spacing and detail visibility were fixed before acceptance. Final local suite: 341 discovered, 337 passed, four platform/opt-in skips and zero failures. Type checking, production dependency audit and package checks passed. A screenshot from the official renderer was delivered through send-file with a sent receipt. A new clearly labelled widget using the corrected HTML was then accepted and edited in the exact existing Telegram topic, without a caption, new topic, native session or model turn. The initial preflight encountered a proven pre-connect failure; a safe bounded retry succeeded. The owner then confirmed that the new card shows Done and Finished in the actual Telegram client, without the growing Last update footer.

## Post-fix widget API acceptance

A separate clearly labelled diagnostic card was sent to the verified existing current-session topic with TelegramClient after the fixes. Production sendWidget returned a positive widget Message receipt and the expected message_thread_id on its first attempt; editMessageWidgetData then confirmed an update to that same message. No new topic, native session, model turn, permission or view preference was created or changed. This is direct API acceptance; appearance on the physical client remains user acceptance. The earlier unknown card was not replayed.

The full local suite remains333 discovered/329 passed/four skips. CI for00bded5 initially failed before creating jobs; its bounded rerun completed macOS/Node24 and Linux/Node22 successfully but ended overall failure with the other matrix jobs absent. No failing test logs were available for the missing jobs. Complete cross-platform CI is therefore not claimed for this follow-up.

## Development: topic before native session

New /new operations confirm a Telegram topic before thread/start. Regression tests assert zero native sessions for topic4xx/5xx/unknown responses and interrupted requests, no repeat after reconnect, explicit empty-topic binding, attempt-fenced retries and positive topic receipt before the sole native start. Legacy fixtures retain the older native-first operation shape to verify already-created sessions remain recoverable. Final full suite:333 discovered,329 passed, four platform/opt-in skips and zero failures. Clean types/build, package checks and audit passed. The isolated real-native /new test also passed without a model turn or real Telegram writes. Two independent review axes found no remaining blocking issues. Unstarted legacy operations are upgraded before native creation; a reserved topic cannot be claimed by another pending operation. The local relay was restarted with the reviewed code; no further live topic creation was attempted after the user reported duplicate inaccessible topics.

## Development: unloaded creation recovery follow-up

User feedback showed two identical visible topics with inaccessible history and a recovery button requesting a local resume. Read-only native inspection established that the exact relay-created empty session was persisted but unloaded. A regression reproduced the button failure; the fix restores only the verified, allowed, non-archived owned ID, retaining ordinary terminal-session readiness guards. Tests reject archived histories, substituted IDs and scope revocation during metadata reads. `BOT_TOPIC_WRONG_HOME` is classified as unknown, including migration of known saved refusals; no topic identity is inferred from its name or warning. The exact mechanism behind the inaccessible Telegram topics remains unverified.

Final local suite: 327 tests, 323 passed, four skips, zero failures. A live qualification resumed the same unloaded owned ID and confirmed readable empty history (zero turns), with Telegram calls disabled. No new native session, model turn, topic creation or binding was issued during that qualification. The relay was then restarted. Earlier commit b9449e2 passed all six platform/Node CI jobs; follow-up CI is checked independently.

## Development: topic recovery and widget transport failures

Regression tests reproduce a scratch session already created in Codex while Telegram rejects its topic, and verify recovery controls in the original menu, no repeated background prompt, rejection of cross-topic callbacks and retry using the same native session. Connection classification tests distinguish DNS/connect failures from resets, response-body errors and ambiguous aggregate errors. Widgets retry proven pre-connect failures after three seconds, preserve known message receipts and retry outcomes across temporary local persistence errors, and never replay an unknown initial send. Bounded failure categories are stored without transport causes or credential-bearing URLs. Unknown sends select Classic for following turns; explicit `/view widgets` enables future cards without replaying the uncertain card.

Final local validation: 325 tests discovered, 321 passed, four platform/opt-in skips, zero failures. Clean installation, typecheck, production dependency audit and package checks passed. The exact local relay process was restarted after checking there were no in-flight writes. A deliberate retry for an existing definitely rejected topic first hit a proven pre-connect failure, then the normal worker retried and received `BOT_TOPIC_WRONG_HOME` again. The native session ID remained unchanged, the originating menu was updated, and its old uncertain widget admission remained consumed. Bot topic mode was confirmed enabled; the exact undocumented server refusal remains unresolved.

## Development: home-directory project collision (2026-11-09)

A binding for the user's home directory appeared in automatic project candidates. It was correctly excluded from project buttons because it contains private relay/Codex data, but still participated in scratch overlap validation. This incorrectly suppressed the general-conversation choice under AppData.

The fix filters ineligible projects before any workspace overlap check. A regression through Bridge reproduces the home binding, asserts the first actual Telegram keyboard button is “Без проекта”, and creates the selected session. A separate isolated replay of the device's configuration/bindings failed before the fix and passed afterwards with the expected first button; it sends no Telegram messages and creates no native session. Full local suite: 287 discovered, 284 passed, three environment-gated skips; build and package verification passed.

## Development: automatic /new defaults (2026-11-09)

Removed the mandatory `new enable` setup step. Existing installations without `newSessions` get an enabled general-conversation workspace and known project choices automatically. Defaults are computed without rewriting configuration or creating folders during a config read; `/new` creates its workspace after owner authorization. Explicit overrides and intentional disable remain respected.

Regression coverage includes a legacy configuration, first-use workspace creation, no directory creation for an unauthorized sender, known project choices under all/selected scope, omission of scratch UUID projects, and file export through a separate producer using the same implicit defaults. The real-native qualification now runs the complete creation/restart/archive scenario without any `newSessions` configuration section.

Local results: 286 tests discovered, 283 passed and three environment-gated skips; the separately enabled native test passed. Build, type checking and package verification passed.

## Development: /new creation (2026-11-09)

Tests exercise topic-less and bound origins, general/project selection, first-response baseline, duplicate updates/clicks, unknown native starts, uncertain naming, uncertain topic creation and `/bind`, selected-scope ownership/revocation, callback authorization/expiry, path substitution, persisted operation recovery and restoration without unarchiving. File-export coverage includes owned scratch producer/worker admission, readable labels and rejection of neighboring conversations. Transport assertions check exact start/name fields and absence of synthetic turns or permission overrides.

The opt-in native test uses its own temporary `CODEX_HOME` and local App Server, fake Telegram and no model turn. It runs actual Bridge `/new`, reads empty history, restarts only that App Server, restores the same ID, archives the test thread and proves no unarchive/resume occurs. It passed locally on Windows with Codex CLI 0.166.0. The isolated native config remained unchanged. Real Telegram topics and the user's Codex profile were untouched.

```powershell
npm run build
$env:CODEX_RELAY_NATIVE_NEW='1'
node --test dist/test/native-new-sessions.test.js
Remove-Item Env:CODEX_RELAY_NATIVE_NEW
```

The default suite skips native qualification without the flag; CI uses deterministic adapters. Requalify storage/archive behavior before supporting a changed history layout. Named empty threads are durable and resumable but absent from ordinary `thread/list`; list absence is not evidence of archival.

Final local checks: 282 tests discovered, 279 passed and three environment-gated skips; the separately enabled native test passed. Type checking, build, package allowlist and production-dependency audit passed (zero reported vulnerabilities).

## Development: compact code approval cards (2026-11-08)

The owner refined code previews to a few lines in a single ordinary message rather than divided collapsible quotations. Embedded scripts and fenced reason examples now show at most six code lines including an omission marker, with a 600-unit/six-line abbreviation threshold. Repeated execution-policy code may refer to the command preview instead of duplicating it. A code-heavy approval retains the full-command warning and native decision controls in the same message. Large non-code review context, file diffs and permission requests keep their prior delivery rules and original identities.

Integration regressions first rejected the quotation-based preview, then verified one send, actual `pre` entities, bounded code lines, surrounding prose outside the source block, no quotation/spoiler entities and an unchanged native decision. The earlier forced single-preview collapse and larger code budgets below describe previous behavior and are superseded by this refinement. Tests use synthetic native/Telegram adapters; the running relay was not restarted.

Review reproduced two additional failures: CRLF/CR reason input bypassed source recognition, and eight large examples collectively overflowed the card. Display-only newline normalization and a shared 1,000-unit excerpt budget now handle these cases; at most the first two and last source examples remain, with a visible notice for omitted blocks. Both new integration regressions failed before their fixes and passed afterward. Windows validation: **257 tests, 255 passed, two platform skips, zero failures**; clean install, type checking, build, runtime audit (zero findings), package allowlist and whitespace checks passed.

## Development: collapsed approvals and code previews (2026-11-08)

A Telegram screenshot exposed a presentation mismatch: `spoiler` masks text without reducing its height. Approval bodies now use Telegram's collapsed-by-default `expandable_blockquote` entity. A regression failed on the masking entity before the change, then passed with collapsible blocks. Resuming an older persisted plan converts only its unsent parts without reposting confirmed receipts; this upgrade path also failed before its fix.

Abbreviated embedded-code previews stay collapsed even when they fit in a single message; their warning remains outside the collapsed body. A focused regression reproduced the earlier single-message path bypassing collapse.

The owner clarified that code inside the command should also be abbreviated. Embedded scripts and their execution-policy amendment code strings now use labelled head/tail previews after 2,000 UTF-16 units or 40 lines, with an explicit warning that the button approves the original full command. A new integration regression covers inline code, its duplicated policy suggestion, unchanged native parameters and the resulting decision. Multipart lifecycle fixtures use complete unquoted context so they still exercise multiple messages after command previews become shorter. Earlier full-command display guarantees below describe the preceding implementation and are superseded by this explicitly approved preview behavior. No running relay restart or live Telegram send was performed.

The scope regression preserves long ordinary arguments, quoted multiline data and `-e` inside script arguments; recognized interpreter flags must precede the script entrypoint. Simple heredocs require an unquoted header and matching terminator. Unknown command patterns keep the full text. Windows validation passed **255 tests: 253 passed, two platform skips, zero failures**, plus type checking, build, runtime audit (zero findings), package allowlist and diff whitespace checks. The three new tests cover old-plan upgrades, code/policy previews and the code-versus-data boundary.

## Development: multipart approvals (2026-11-08)

Supported approvals no longer fail the former 18,000-character payload/card limit or inherit ordinary answer truncation. Twelve new synthetic integration tests cover complete 60,000+ character commands, file diffs and permissions; numbered spoiler parts and Unicode boundaries; controls withheld until the final receipt; exact native decisions; checkpoint/restart recovery; missing receipts and ambiguous delivery; native cancellation; definite entity rejection; persisted rate-limit pauses; and selective abbreviation of quoted reason context. Existing replay and bridge tests were updated to verify final keyboard edits and unchanged review text. Review found two lifecycle races: retirement during a successful send lost its receipt, and finalization could overwrite a cancellation. Both were reproduced with failing regressions and corrected with guarded state transitions.

Windows validation: **252 tests, 250 passed, two platform skips, zero failures**. Build, type checking, runtime dependency audit (zero findings), package allowlist and diff whitespace checks passed. Tests use synthetic Telegram/native adapters; no real approval was created or answered. The running relay was not restarted, and live Telegram appearance remains an acceptance check. Cross-platform CI is required before promotion to `main`.

## Development: account limits (2026-11-08)

`/limits` reads the current account snapshot through the existing `account/rateLimits/read` connection and works without an attached session topic. Dynamic windows/groups, remaining percentages, timezone-labelled reset times, optional credits/spending restrictions and explicit unavailable data are covered. Backend restrictions remain authoritative; past reset timestamps do not imply recovery. Read errors stay local to the command and raw errors are not sent to Telegram.

The native contract was checked against the official App Server documentation and local generated Codex schema. A read-only live shared-daemon probe succeeded during planning; no model turn, account switch or settings write was generated. Automated checks passed 240 tests (238 passed, two platform skips), type checking, build, runtime audit (zero findings), package allowlist and diff whitespace validation. Six new tests exercise the real WebSocket test peer, owner authorization, duplicate updates, active questions, fresh reads, formatting and missing/expired data. A live Telegram `/limits` acceptance check still requires restarting the updated relay. Cross-platform CI is required before promotion to `main`.

## v0.1.18 release candidate (2026-11-06)

This candidate promotes task-aware signatures, the simpler command menu and contextual recovery. Both READMEs target v0.1.18 and contain no references to the removed instruction command. Package/lock/native metadata agree on 0.1.18. The exact candidate passed 234 local tests (232 passed, two platform skips), type checking, build, runtime audit (zero findings) and package allowlist. Required cross-platform CI must pass in the release PR before promotion; existing live acceptance limitations remain below.

## Development: task labels and simpler commands (2026-11-06)

`/say` is removed from parsing, help and registration, with no replacement instruction button or mode. Ordinary text retains the existing question-answer behavior. `/questions` republishes actionable choice/free-text cards, including a liveness check after asynchronous reads; a regression first reproduced a resolved question returning as a dead card and now verifies that no copy is posted.

Native session names appear in ordinary/rich output, multipart fallback, live previews, model controls and file captions, with the short thread ID as an unnamed-session fallback. Nullable binding/outbox/file-job columns preserve labels at queue time and across SQLite reopen; legacy records keep their original project-only form. The official App Server thread/name contract and local Codex 0.166.0 notification schema were checked. A delayed discovery regression reproduced overwriting a newer rename; event revisions now preserve the newer label. File schema migration is serialized for concurrent producers.

Recovery commands remain available manually/in help but are hidden from the main bot menu. Attempt-scoped buttons can select a session for `/bind` without an ID in the destination topic, or explicitly retry creation. Selection expires after ten minutes and does not survive reconnection. Loaded-session scope/readiness and the current attempt are checked again at the final bind step. Regression tests first reproduced binding an unloaded/moved session after an earlier valid click; those paths now reject the binding. Repeat clicks after creation cannot reuse the old attempt.

Windows validation: **234 tests, 232 passed, two platform skips, zero failures**. Build, type checking, runtime dependency audit (zero findings), package allowlist and `git diff --check` passed. Both review findings and the additional eligibility finding were reproduced, corrected and re-reviewed. All tests use synthetic Telegram/native adapters; no real question, approval or topic-recovery action was generated. The existing relay needs a restart to load these development changes and synchronize its command menu.

## v0.1.17 release candidate (2026-11-06)

The release includes the session model picker, opt-in outgoing files, durable final delivery, attachment/readiness fixes, subagent approvals and approval/startup recovery corrections described below. English/Russian READMEs and installation tags now identify v0.1.17. Package and native client metadata agree on the version. The exact candidate passed 223 local tests (221 passed, two platform skips), type checking, build, runtime audit (zero findings) and the package allowlist. Cross-platform Node 22/24 CI is required on the release PR before promotion; live Telegram model selection and other outstanding acceptance limits remain as recorded below.

## Development: session model picker (2026-11-06)

`/model` now loads the native catalog on each command, lists models in its first screen and complete reasoning/speed combinations in its second. A combination applies immediately; there are no Refresh/Apply buttons. Initial RED tests reproduced the absent command and second screen. Additional RED-to-GREEN checks removed an unsafe guess from legacy speed names to native tier IDs, and restored a visible explanation when eligibility changes during catalog loading.

The synthetic Bridge/SQLite/Telegram suite verifies fresh/new models, future effort/tier IDs, absence of unadvertised Fast, explicit standard speed, model/settings pagination, Back/Cancel/expiry, foreign/group/cross-topic/cross-message controls, moved/ignored/detached/rebound/reconnected sessions, catalog changes/errors, concurrent clicks and uncertain-write non-replay. The exact current-thread settings payload is tested through the real stdio/WebSocket transport with a local native peer, including all catalog pages and a repeated-cursor rejection. Changing an active session issues no start/steer/interrupt request and reports that following requests use the saved settings.

Protocol qualification used official App Server documentation plus the generated experimental schema from installed `codex-cli 0.166.0`. A read-only catalog inspection confirmed the current effort/tier fields. A live method-recognition probe deliberately omitted required `threadId`: the daemon rejected it with `missing field threadId`, confirming recognition without targeting or modifying any thread. The public documentation does not currently describe the experimental settings setter. No live settings update, inference turn, approval decision or Telegram menu click was fabricated for testing; actual client acceptance after restart remains a separate check.

Final Windows validation: **223 tests, 221 passed, two platform skips, zero failures**. `npm ci`, typecheck, build, runtime dependency audit (zero findings), package allowlist/dry run and `git diff --check` passed. Two independent reviews checked the agreed behavior and project standards; the legacy speed finding was corrected and re-reviewed. The package contains 25 allowlisted files and excludes local state and test/research data. The existing foreground relay was not replaced; restart it to load the new handler and synchronize `/model` into the bot's owner menu.

## Development: Telegram startup retries (2026-11-06)

A CLI integration regression first reproduced the exact `Telegram getMe connection failed. Delivery may be uncertain.` error and immediate exit before any native connection. Startup now retries temporary bot identity/webhook check failures after three seconds. The test observes actual timestamps across a network failure, a 503 response and eventual recovery, then verifies one native client starts successfully. Additional cases cover webhook-check recovery, a longer 429 interval and fatal 401 without starting Codex. The existing polling recovery and competing-consumer checks remain green. All calls use synthetic Telegram responses and disposable state, with no real bot credentials or model turns.

Windows validation: **205 tests, 203 passed, two platform skips, zero failures**. Type checking, build, package allowlist and `git diff --check` passed. The built correction takes effect on the next relay start; no running foreground process was replaced during these checks.

## Development: repeated pending approval cards (2026-11-05)

The original reproduction submitted the same pending approval three times across three Bridge generations, including after a lost Telegram acknowledgement. It now submits once: confirmed cards receive fresh buttons and uncertain sends remain a single uncertain delivery. The implementation persists native request identity separately from destination/card receipts and callback authority. Distinct requests or changed permissions are not merged by visible text, and a consumed decision cannot be submitted again after reconnect, SQLite reopen or topic recovery.

Sixteen approval-replay regressions cover those cases, multipart text/final-button receipts, held-card admission, retention beyond seven days, resolution before replay, wrong owner/topic and stale controls. Delayed HTTP regressions first reproduced stale keyboard writes and recovery triggered by an obsolete missing-topic error; they pass after ownership and binding checks. The subagent integration reconnect now replays the same native RPC ID, matching Codex 0.166.0 source, and expects one card with refreshed controls. Three CLI integration tests use real subprocess/stdin/WebSocket plumbing and intercepted Telegram calls: transient polling errors no longer restart the native client, while 401 and 409 remain fatal. No real bot, model turn or approval response is used by these tests.

Final Windows validation: **201 tests, 199 passed, two platform skips, zero failures**. Type checking, build, `git diff --check` and the package allowlist passed. Two independent reviews verified the corrected races. The running foreground relay has not been restarted by this work, so live acceptance of the built fix remains pending. Legacy cards lack the required native identity; the first replay after upgrading may create one new card before durable reuse begins. [Diagnosis, primary sources and implementation](research/repeated-approval-cards-2026-11-05.md).

## Development: subagent approvals (2026-11-05)

Read-only native metadata and Codex 0.166.0 source confirmed that child approvals retain the child's thread ID, while parent resume replays only the parent's requests. The original routing regression delivered zero child cards to an authorized parent topic. Seven integration scenarios now exercise verified ancestry, origin-labelled parent-topic delivery, a single response to the original RPC, owner/topic/scope rejection, independent parent/child lifecycle, complete child file diffs, actual client/transport replacement with a new pending RPC ID, and replay after parent-topic recovery. The last scenario first failed during review and passes after descendant subscription invalidation. These tests use synthetic native/Telegram peers and temporary databases, not real approval decisions.

The initial reconnect fixture used a new ID; the repeated-card correction above subsequently aligned replay with the same live-daemon RPC ID and verifies reuse of the existing card.

Final Windows validation: **182 tests, 180 passed, two platform skips, zero failures**. `npm run typecheck`, build, `git diff --check` and `npm run check:package` passed; the package check admitted 24 files and excluded local state, tests and audit copies. The first-message reproduction remains green. Two independent reviews checked requirements and project standards; the replay finding was corrected and re-reviewed. The correction is built locally; live acceptance requires a relay restart and an actual pending child request. [Investigation and implementation](research/subagent-approvals-2026-11-05.md).

A read-only probe of the affected child's actual native metadata also resolved the expected existing root topic through the new ancestry resolver. It checked the loaded root's saved binding without sending a model input, approval response or topic operation. This does not claim end-to-end event delivery by the running relay.

## Development: first-message attachment (2026-11-05)

Live native probes identified a loaded interactive session with a reserved rollout path, a specific pre-first-message history rejection, and a resume rejection. Regression tests reproduced the lost readiness distinction, premature topic creation, misleading saved-topic replies, manual-recovery bypass, and loss of a fast first answer. The fix is exercised through the actual WebSocket proxy client, Bridge and SQLite state with synthetic native/Telegram peers, including reconnection, healthy neighboring sessions, successful empty history, unrelated native errors, media rejection before download, and no replay of rejected input.

Local Windows validation: 175 tests, 173 passed, two platform skips, zero failures. Existing approval replay, scope and topic recovery tests remain green. This is not live acceptance of a restarted relay. No first model message was injected into a user session during diagnosis or testing.

## Development: queue, scope and discovery regressions

Three failing tests reproduced completion loss at a full 1,000-entry queue, old excluded-project output still sending after scope narrowing, and root sessions hidden behind more than 64 loaded subagents. After the fixes, synthetic tests retain two finals through a later baseline and an actual SQLite reopen, expose the pending-final count, and deliver each once without native writes. Scope tests cancel blocked/deferred finals, queued controls and project notices, prevent cancelled work returning after scope expansion, and stop ordinary/rich multipart output when scope is revoked between parts. Discovery integration tests use the real stdio/WebSocket peer with 80 subagent contexts, filter selected roots before capacity, and observe an explicit overflow warning only for more than 64 eligible sessions. These checks use disposable stores and adapters; no real bot request or user session is started by them.

## Outgoing-file development checks

Synthetic export tests exercise a separate CLI process concurrently with the relay's singleton state, with no bot token present; local opt-in; exact session/topic/owner routing; ambiguous selection; path escapes, private-data paths, links/junctions, hard links, empty/oversized files and Windows alternate streams; frozen and tampered snapshots; disabled/ignored/closed/moved sessions; deduplication; queue bounds; interrupted/expired work; 429 cooldowns; uncertain transport and shutdown; and an ordinary message with buttons completing while an upload is held. Multipart adapter checks use an injected fetch implementation, verify the fixed endpoint and actual FormData contents, and check token redaction. These are not a real Telegram upload acceptance check.

## 0.1.16: account-security onboarding (2026-11-03)

The English and Russian installation prompts and bare-link instructions now require an explicit user-facing security explanation before pairing, changing discovery scope or starting the relay. Setup prints a one-time warning before connection/pairing. No acknowledgement gate, new permission grant or Telegram account-setting change is introduced; existing owner checks and native approvals are unchanged.

Local Windows verification passed: clean installation, typecheck, 134 tests (132 passed, two POSIX-only skips), runtime dependency audit with zero findings and the distribution allowlist. Research notes remain excluded from the installable package. CI must be checked for the final release SHA before claiming cross-platform validation. Human instructions specify what agents must explain; compliance by arbitrary third-party agents is not an enforceable security boundary.

## 0.1.15: per-installation command menus (2026-11-03)

Windows local checks: clean installation, typecheck, 134 tests (132 passed, two POSIX-only skips), package allowlist and dependency audit with zero findings passed. The implementation commit `67d5ca2` also passed all six Windows/Linux/macOS Node 22/24 CI jobs; release metadata requires its own checks before promotion. Seven menu tests cover owner-chat scoping with a distinct synthetic owner ID, English/Russian descriptions, idempotent synchronization, independent language failures, uncertain settings-response readback and usable no-argument menu commands. Explicit hostile-input checks send every advertised command and parameterized variants from a stranger, an owner in a group, and a mismatched sender/chat pair: no replies, native instructions, preference changes or topic changes result.

The real paired bot accepted nine commands in its configured owner's chat, with default English and Russian descriptions. `getMyCommands` confirmed both lists; broader default-language scopes were unchanged. A second synchronization made no writes. This acceptance used the local pairing configuration, not a hardcoded account, and did not poll updates or change native sessions. Menu rendering/caching depends on the Telegram client. Registration happens during setup/start, while `doctor` stays read-only; failed UI synchronization does not stop relay delivery.

## 0.1.14: streaming acceptance (2026-11-03)

Windows, Node 22.21.1, Codex 0.166.0: `npm ci`, typecheck, the full suite (127 tests: 125 passed, two POSIX-only skips), runtime dependency audit (zero findings), isolated official CLI installation smoke check, and distribution allowlist (21 files, approximately 74 KB, no local state/secrets/test data) passed. The streaming implementation commit `39adefa` passed all six CI jobs (Windows/Linux/macOS, Node 22/24); release metadata changes require their own CI checks before promotion.

New automated checks cover burst coalescing, fair topic pacing, shared cooldowns across reconnects, stable draft identity, valid paragraph-to-table rich snapshots, literal HTML/media handling, Unicode-safe preview bounds, stale item/turn rejection, owner-only persisted settings, all/compact eligibility, native directory scope checks, detach/topic changes, completion during scope validation and an in-flight draft followed by a permanent final. A table longer than the preview buffer arrives with every row and its end marker even after preview transport failure. The existing 40,000-unit final-source limit is unchanged.

Two separate local acceptance checks were performed; they are not an end-to-end mobile UI claim:

- Real paired Telegram bot, this project's existing owner topic: four `sendRichMessageDraft` updates succeeded, followed by one permanent ordinary answer and one permanent rich table. Test payloads were synthetic. No updates were polled, no topics were created/renamed/deleted, and the running relay's state was opened read-only. After restarting the relay, the owner also confirmed that a long streamed assistant answer with headings, a list, a quotation and a table displayed correctly in their Telegram client. The exact client/build was not recorded; identical behavior across other client versions is not claimed.
- Real shared Codex daemon, isolated ephemeral no-tool turn, Telegram simulator: 288 native assistant deltas, `final_answer` phase, three rich previews, all 30 final table rows and the end marker preserved. Native execution policy was not overridden. Ephemeral threads have no rollout/resume/turn-history support, so the acceptance adapter used its already-owned session and in-memory empty history; live events and directory reads were real. Normal persistent-session attachment remains covered by the existing transport/release qualification.

The single writer orders settled local preview calls before permanent sends. A network timeout still has an uncertain server outcome; no absolute client-order or delivery guarantee is claimed. Preview failures remain separate from the durable outbox and never authorize replay of native instructions or uncertain permanent messages.

Initial local qualification: 2026-11-02, Windows, Node.js 22.21.1, Codex CLI/shared daemon 0.166.0.

## 0.1.13 rich messages and readable approval cards

Release-candidate validation on 2026-11-03 (Windows): 112 tests, 110 passed, two Unix-only skips, no failures. Type checking, build, runtime dependency audit and the package-content check passed. The isolated official Codex 0.166.0 native executable/proxy check passed without starting a daemon or model. The installable package contains only the allowlisted CLI, public READMEs and architecture/verification documents; private state, research notes, video files and generated media projects remain excluded.

A new integration regression failed before the release fix because CommonMark normalized CRLF/bare carriage returns inside command approvals. Commands containing invisible C0/DEL controls now use a clearly labelled JSON-string display. CRLF, bare CR, NUL, ESC, DEL and literal backslash sequences round-trip through the sent pre entity to the exact original command; native approval input remains unchanged and no command is executed by this test. Oversized rich-block fallback retains complete text but can simplify inline styling, as documented in both READMEs.

Rich-message regressions first reproduced ordinary pipe-table output, missing row-boundary splitting, failure to provide readable fallback and replay of an accepted table prefix after topic recovery/restart. These now pass through State/Outbox and a Telegram test adapter. Coverage includes native table/header/topic/signature fields, Unicode and oversized cells, wide-table row cards, literal HTML/code and blocked local links, partial fallback, final-part controls, rate-limit handling, unrelated/uncertain failures, and SQLite recovery with accepted-part progress. Windows validation: 111 tests, 109 passed, two platform skips.

A single labelled sample using the production rich-block builder was accepted by the real Telegram Bot API in the paired owner's existing project topic, returning a message ID. It contained a native table, heading and italic project signature. The owner confirmed its appearance looked good in their current client. The check read the saved binding without opening a second relay, used no native model turn, and recorded intent before its one POST without retry/fallback. This verifies live API acceptance, routing and the observed client presentation; other Desktop/mobile versions remain unqualified.

Regression tests reproduced the raw JSON command display before the fix. New command cards retain literal command characters (including nested Markdown fences and trailing whitespace), show reason and working directory, remove transport metadata and duplicate parsed actions, and retain additional permission/security fields. Multipart commands remain complete and expose controls only on the final part. File/permission approval payloads remain complete inside literal code blocks. Existing owner/topic checks, one-shot callbacks, request resolution and oversized-request terminal fallback remain covered. Local Windows validation: 101 tests, 99 passed, two platform skips; type/package checks passed and the runtime audit reported zero known vulnerabilities. Live appearance requires restarting the local relay and receiving a new native approval; no real approval was created or answered during these tests.

## 0.1.12 automatic discovery

Windows validation: 98 tests, 96 passed and two Unix-only tests skipped; type checking and package-content checks passed. Regression coverage verifies a later session in a new project receives one persistent topic, accepts native input and returns assistant output in automatic mode; ignored sessions remain excluded. Topic recovery also accepts explicitly enabled automatic scope while retaining ignored-session checks. Selected-project regressions remain unchanged. Runtime dependency audit reported zero known vulnerabilities.

The implementation commit c5c0b48 passed all six CI jobs on Windows, macOS and Linux with Node 22/24. Release instructions point agents to main and installation to the version tag; selected-project defaults remain unchanged.

A read-only check against the existing daemon confirmed the missing new-project session was loaded but outside selected roots. After explicitly enabling automatic scope in the local configuration, that same session passed directory eligibility and the previously ignored session remained ignored. No model turn or native attachment was used for this check. Real topic creation under the new mode still requires restarting the existing relay and observing the resulting binding.

## Public preview acceptance

Version 0.1.11 passed CI on Windows/macOS/Linux with Node 22/24. The final Windows environment fix isolates the ACL helper from inherited PowerShell 7 module paths. Real Telegram photo input reached the selected native session and was visually identified. A live host-question choice returned from Telegram to that same session, confirming the reverse question-answer path. Full authenticated installation and bot exchange on a clean Mac/Linux machine, and sleep/network-outage acceptance, remain follow-up checks; they are not implied by CI success.

## 0.1.11 audited fixes

Regression tests first reproduced broad pre-existing Windows grants, silent oversized/capacity-limited questions, a question disappearing after a later turn/reconnect, an answer consumed before any native write, and partial answers lost across a new RPC ID. These scenarios now pass through the real configuration/reader/Bridge interfaces with synthetic native/Telegram adapters. Windows tests inspect actual filesystem ACLs on disposable directories/files; repeated saves preserve access without requiring audit-policy privileges. SQLite reopen tests verify interrupted host-answer attempts remain non-replayable and matching drafts/recovery timestamps survive.

Missing-executable tests verify native rediscovery changes only the in-memory candidate until compatibility checks succeed; tokens/config remain byte-identical during resolution. Existing invalid files are rejected unless explicitly overridden. Runtime start checks initialization and the loaded-session interface before saving a replacement path. Installation of official Codex on CI remains a command/install smoke check; a complete live Mac installation is still an acceptance check.

## 0.1.10 journal recovery

Large-journal tests reproduced both false restart/next-turn warnings and an actual current question lost before a 9 MiB tool output. They pass with streamed recovery, including an answer after a large output suppressing an already resolved question. Read-only checks of four selected live journals (largest approximately 99 MiB) returned no false recovery markers; native sessions were not modified. A real Telegram photo subsequently reached the native conversation and was visually identified, completing the incoming-photo acceptance check. The later public-preview acceptance above includes a real returned host-question choice.

## Automated

Version 0.1.9 adds synthetic tests for owner/root checks before attachment download, safe random cache paths, caption forwarding, image input framing, native-question attachment answers, actual streamed download limits, path traversal and token-error redaction. Host async-question tests cover split journal records, current-turn filtering, native UI answers, secret-format fallback, topic isolation, free-text answers and reconnect consumption. Stale-approval and missing-partial-answer tests failed before their fixes and now pass. The bounded journal reader also recovered the actual missing questions from a selected native session without printing their contents. A real Telegram question copy was accepted in the saved project topic. Later photo and host-question acceptance results are recorded above.

The test suite exercises session/topic routing, duplicate input suppression, owner/private-chat checks before journaling, busy-turn steering, uncertain-write handling, commentary filtering, completion deduplication, one-shot topic-scoped approvals, native resolution, multi-question capability rotation, unsupported/oversized requests, root containment, policy changes being unavailable remotely, SQLite recovery and lock handling, token-error redaction, Unicode chunking, and HTTP/WebSocket-over-pipes framing.

Normal automated tests use synthetic data and no real bot credentials or model turns. `npm audit` reported no known advisories for the locked runtime and development dependencies at the time of qualification. That result is time-dependent.

## Native acceptance checks performed locally

Two independent clients connected to the real existing shared daemon. An isolated test project and test native context were used; unrelated user sessions were not resumed or modified. A Telegram test adapter replaced Telegram's network calls.

Verified:

1. HTTP upgrade and WebSocket messages over `codex app-server proxy`.
2. Loaded-session discovery separates interactive root sessions from subagents and skips ephemeral/unmaterialized contexts.
3. A second client resumes the selected test thread without changing its read-only sandbox or on-request policy.
4. A real no-tools model answer is received by the second client and delivered as a final Telegram-adapter message.
5. A native command-execution approval initiated by the first client arrives at the second client. A simulated owner click sends the native cancellation decision. The requested elevated echo is not executed.
6. A native multiple-choice question is answered through a simulated Telegram callback.
7. A steering message is accepted for that same active native turn.

The native server offered `accept` and `cancel` for the tested approval, rather than `decline`. The relay now renders the advertised choices and has a regression test for this case. A blank native context cannot be resumed before its first input; discovery waits for materialization instead of creating replacement sessions.

## Experimental activity widgets (dev)

Behavioral coverage verifies default-Classic/per-session view selection, turn latching, existing verbosity/text-preview independence, unchanged native settings/input, one card per long turn, quick-turn suppression, safe tool categories, real structured-plan counters, normal final-answer delivery and waiting states without answering prompts. Delivery cases include uncertain sends across restart, definite API rejection, 429 pacing, retryable edits to known messages, final-revision ordering, rebind rejection, Unicode/JSON-escaping limits, durable preference recovery and shared-context checks.

Local Windows validation passed 319 tests: 315 passed, four platform/opt-in skips, zero failures. The two separate real-native `/new` and `/permissions` qualifications also passed in temporary isolated homes. Clean dependency installation, typecheck/build and official-runtime acceptance were completed; package/dependency and cross-platform CI results are checked separately before publication.

Independent Standards and Spec reviews reproduced an unsafe receipt eviction at 512 records, terminal states being overwritten when outside bounded history, and missed item completion not being reconciled. Regression tests now exercise 520 intervening turns, uncertain-route retirement/age, full protected capacity, missing terminal history and existing-card item recovery. Protected receipts are retained; new admission stops instead of deleting them. Both review axes reported zero remaining findings after the fixes. Windows fixture cleanup uses bounded retries for an already observed `EBUSY` temporary SQLite unlink failure and waits for native child stdio to close before removing its temporary home; it retains the resolved-path safety check.

Official `TelegramMessenger/widget-sandbox@7a2ec35e3e7698377626e982e98e5a1161b1aac8` WidgetHost qualification ran the actual QuickJS worker, validator and iframe renderer in headless Chrome 156. Twenty-two cases passed: widths 320/430, light/dark, text sizes 20/24/32/64, waiting status, RTL safe area and theme/font-only transitions without changing widget data. No runtime death, error, profile rejection or overflow was observed; heights were 276–508 px. The qualified template was 4520 source bytes and 1806 zlib bytes. Browser previews are sandbox acceptance evidence, not screenshots from the user's Telegram app.

Production Bot API accepted `sendWidget` in the exact saved current-session topic, returned a widget message receipt, and accepted its `editMessageWidgetData` update. No model turn, permission change or configuration rewrite was sent. Creating a separate acceptance topic was definitely rejected with `BOT_TOPIC_WRONG_HOME`; the error is not documented by the checked primary sources, so no alternate owner, endpoint or settings were inferred. The existing current-session binding was used instead. Client rendering on the user's physical Telegram devices remains a separate acceptance check.

## Consistent English interface (main/dev after v0.1.19)

All relay-owned Telegram copy now uses English, including model/permission/project pickers, quota reports, recovery buttons, scratch labels and code-preview warnings. Existing behavioral tests assert the English text while retaining routing, preview completeness and one-shot approval checks. Command-menu tests verify that a previously registered Russian list is replaced independently with the same English descriptions as the default list. Native/user text remains in its original language; existing Russian reply/task-title fixtures continue to check its preservation. Persisted approval/message bodies are not rewritten or replayed to change their language.

## Session permission selection (main/dev after v0.1.19)

The `/permissions` regression suite checks a live/custom/paginated catalog, owner/private-chat/message/topic binding, expiry, reconnect/rebind, cancellation, changed settings and managed restrictions. Full Access requires a second confirmation. Reviewer-only changes preserve the profile; profile changes preserve the reviewer. Duplicate/concurrent callbacks and uncertain writes cannot repeat the native change. Proxy transport tests assert exact field whitelists, external-settings invalidation, bounded catalog parsing and an uncertain outcome when the applied notification is absent.

Local Windows validation: 302 tests, 298 passed, four platform/opt-in skips, zero failures. The separate native permission test also passed. Clean dependency installation, typecheck/build, runtime audit (zero known vulnerabilities), package allowlist check, `npm pack --dry-run` and whitespace checks passed. Cross-platform CI and actual Telegram presentation remain separate acceptance checks.

Run `CODEX_RELAY_NATIVE_PERMISSIONS=1 node --test dist/test/native-permissions.test.js` after building (PowerShell: `$env:CODEX_RELAY_NATIVE_PERMISSIONS='1'`). This opt-in test starts its own native App Server with a temporary `CODEX_HOME`; it never changes the user's daemon or sessions. With Codex CLI 0.166.0, the real native test passed: Full Access needed its separate Telegram-adapter confirmation, profile/reviewer settings survived an App Server restart, no model turn was created and the temporary global config remained byte-for-byte unchanged. Telegram delivery/appearance uses an adapter in this test; a real-client check remains separate.

## Installation acceptance checklist

- Configure a dedicated BotFather bot with private topics and complete owner pairing (performed for one local installation; repeat for each installation).
- Confirm topic creation, final delivery and native questions in an actual Telegram client (performed locally). Real-client approval acceptance remains to be checked; automated approval qualification used the adapter.
- Confirm behaviour after the local computer sleeps and reconnects.
- Verify actual account-specific native approval modes, including any managed or automatic reviewer policies.

No real Telegram exchange, password prompt, file transfer or production deployment is claimed by the synthetic tests or the native-adapter checks.

## 0.1.1 reconnect regression

A real installation exposed a history response exceeding the client's 16 MiB WebSocket limit. The error had been incorrectly labelled as an unavailable daemon. Each reconnect also re-enqueued warnings about an unchanged background approval.

Both failures were reproduced before the fix: a synthetic large-history test disconnected, and four reconnects produced eight warnings instead of one. After switching to display summaries and persistent native attention keys, all 27 tests pass. The same installation's sessions were checked across three native connection cycles with a separate SQLite store and Telegram simulator: no transport disconnect and one terminal-only warning for the unchanged request. The real bot's token, bindings and state were not modified by this verification.

## Live acceptance and 0.1.6 delivery regression

A paired real bot was subsequently checked for topic creation, bidirectional messages, Markdown entities and a native multiple-choice question in a separate test session. A selected answer reached that session and its final response returned to Telegram. These checks do not replace clean-machine or sleep/reconnect acceptance checks.

Two completed answers containing localhost preview links reached the relay but were rejected by Telegram. A controlled live request reproduced HTTP 400 `Wrong HTTP URL`; the local-link and definite-entity-rejection regression tests failed before the fix. After rendering local previews as text, both stored answers were delivered to their original topic without repeating native Codex input. Automated tests also cover switching/persisting message modes, owner checks, commentary deduplication, and plain-text fallback without replaying accepted multipart output.

## 0.1.7 discovery and topic recovery

The unavailable-session, ambiguous-topic-creation and missing-topic scenarios were reproduced using synthetic adapters before the fix. Regression coverage now includes a disappearing thread, a failed resume alongside healthy sessions, transport errors still triggering reconnect, interrupted topic creation across restart, explicit binding/retry, rate limits, and deleted-topic replacement with queued answers preserved. A combined scenario checks that other topics remain usable during uncertain replacement, old approval buttons stay inert, and new buttons require a fresh owner click.

Project signatures are checked for italic styling without full paths, UTF-16 offsets, each multipart message, project notices outside topics, and migration of older SQLite outbox schemas. The recovery tests never delete or rebind real user topics or mutate real Codex sessions.

## 0.1.8 topic display and native executable discovery

Historical record: status topic names were removed in 0.1.9 at the owner's request. Current names remain project/short-ID.

Tests cover owner-only title-mode changes, persisted preferences, idempotent renaming, Telegram rename rate limits, duplicate visible names routing to different native threads, and reconnects without topic creation. Status mode intentionally omits dialogue names and IDs; simple mode preserves the original format.

Unix CI tests resolve an executable symlink and an npm launcher backed by a hoisted native platform package without executing the launcher. A separate installation check downloads official Codex 0.166.0 to a guarded temporary directory, resolves that installation's native executable and runs `--version` plus `app-server proxy --help`. It starts no daemon, authenticates no account and makes no model request. This checks installation/command compatibility, not a complete real-daemon/Telegram exchange on macOS/Linux.
