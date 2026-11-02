# Contributing

`main` is the default release branch. Work on `dev` or feature branches targeting `dev`; ordinary development PRs should use `dev` as their base. Promote a tested release from `dev` to `main` through a release PR after the maintainer approves that release. Do not push development changes directly to `main`, force-push shared branches, or move published release tags. Include tests for changes to owner checks, routing, protocol handling, delivery recovery and approval semantics.

CI runs on pushes and PRs targeting either branch. Create each new version tag from the approved release commit on `main`. Existing published tags remain pinned to their original commits, even when branch/workflow documentation changes later.

Run `npm ci`, `npm run typecheck`, `npm test`, `npm audit --omit=dev`, and `npm pack --dry-run`. CI must pass on Windows, Linux and macOS. Never put bot credentials, local paths, copied upstream repositories, audit dumps or user-session transcripts in a commit or package.

Do not introduce policy overrides, shell fallbacks, automatic replay of uncertain instructions or automatic approval. New native protocol fields must be checked against official documentation and the local generated schema. Live model and Telegram tests are explicit local acceptance checks, not part of normal CI.

Changes should preserve one owner/private chat and one topic per native session. Product changes to tenancy, automatic history imports, attachments, remote permissions or distribution require discussion before implementation.
