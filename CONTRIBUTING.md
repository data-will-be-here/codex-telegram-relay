# Contributing

Work on `dev` or feature branches targeting `dev`. Keep production/default branches protected. Include tests for changes to owner checks, routing, protocol handling, delivery recovery and approval semantics.

Run `npm ci`, `npm run typecheck`, `npm test`, `npm audit --omit=dev`, and `npm pack --dry-run`. CI must pass on Windows, Linux and macOS. Never put bot credentials, local paths, copied upstream repositories, audit dumps or user-session transcripts in a commit or package.

Do not introduce policy overrides, shell fallbacks, automatic replay of uncertain instructions or automatic approval. New native protocol fields must be checked against official documentation and the local generated schema. Live model and Telegram tests are explicit local acceptance checks, not part of normal CI.

Changes should preserve one owner/private chat and one topic per native session. Product changes to tenancy, automatic history imports, attachments, remote permissions or distribution require discussion before implementation.
