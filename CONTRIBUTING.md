# Contributing

`main` is the default release branch. Work on `dev` or feature branches targeting `dev`; ordinary development PRs should use `dev` as their base. Promote a tested release from `dev` to `main` through a release PR after the maintainer approves that release. Do not push development changes directly to `main`, force-push shared branches, or move published release tags. Include tests for changes to owner checks, routing, protocol handling, delivery recovery and approval semantics.

CI runs on pushes and PRs targeting either branch. Create each new version tag from the approved release commit on `main`. Existing published tags remain pinned to their original commits, even when branch/workflow documentation changes later.

Run `npm ci`, `npm run typecheck`, `npm test`, `npm audit --omit=dev`, and `npm pack --dry-run`. CI must pass on Windows, Linux and macOS. Never put bot credentials, local paths, copied upstream repositories, audit dumps or user-session transcripts in a commit or package.

Do not introduce policy overrides, shell fallbacks, automatic replay of uncertain instructions or automatic approval. New native protocol fields must be checked against official documentation and the local generated schema. Live model and Telegram tests are explicit local acceptance checks, not part of normal CI.

The explicitly owner-selected `/model` flow is permitted to update only `model`, `effort` and `serviceTier` through `thread/settings/update` for its attached session. Resume/start/steer retain inherited settings; the picker must not change approval/sandbox policies, global configuration or create a turn to apply a selection. Catalog values and callback authority must remain separate, and uncertain settings writes must not be automatically replayed.

The explicitly owner-selected `/permissions` flow may update only `permissions`, `approvalPolicy` and `approvalsReviewer` on that same attached root through `thread/settings/update`. Standard choices match Codex's complete native presets: workspace/on-request/user, workspace/on-request/auto_review, full-access/never/user and read-only/on-request/user. Custom profiles preserve existing policy/reviewer. Honor live native profiles, feature and managed requirements; confirm Full Access before writing. Opening a menu, ordinary attachment and model selection must not change permissions. Uncertain writes are never retried automatically; qualification uses an isolated native profile and starts no model turn.

The explicitly owner-selected `/clear` flow may replace the current topic's route with one new empty native thread in the same cwd. Preserve Telegram/native history and project defaults; never delete, revert or archive history, terminate terminals, create another topic, or send a model prompt. Persist creation identity and known thread IDs, reconcile unknown starts without replay, atomically retire the previous binding and block its rediscovery. In-flight work and pending controls/deliveries block handoff. Historical answer reads may follow the recorded same-topic/project replacement lineage; mutating controls must not.

Changes should preserve one owner/private chat and one topic per native session. Product changes to tenancy, automatic history imports, attachments, remote permissions or distribution require discussion before implementation.
