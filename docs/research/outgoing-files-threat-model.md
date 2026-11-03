# Outgoing files: account-compromise threat model

Research date: 2026-11-03. Source snapshot: v0.1.15, `2bae861a001f8ac13c878b11a2271cdc0c1fd026`. This is a design analysis, not an implementation or live penetration test. No bot calls, real user files, credentials or runtime settings were used. Outgoing file upload is not currently implemented.

## Main conclusion

Compromise of the paired Telegram account crosses the relay's current authentication boundary. The attacker acts as the configured owner, can read that account's bot conversation and can submit instructions to eligible native sessions. Limiting an upload tool to the owner's chat does not protect confidentiality from someone who controls that chat.

This risk already exists for readable data returned as assistant text. A file-upload feature would make bulk extraction and binary transfer easier; withholding that feature does not turn the existing interactive relay into a safe boundary against owner-account takeover.

The following conclusions are engineering analysis of the reviewed source. They do not assert that any particular private file is readable in an actual installation: the effective native sandbox, OS permissions, available tools and approval policy determine that.

## Current code boundaries

- `src/bridge.ts`, `update()`: the sender must match `config.ownerId`, the chat must match that ID and be private, and bot senders are rejected. This blocks unrelated users, not an attacker using the owner's active Telegram session.
- `sendInput()` routes accepted instructions through native `turn/start` or `turn/steer`. `src/codex.ts` supplies no permission/sandbox override. `SECURITY.md` explicitly describes Telegram as remote control, not a new sandbox.
- `allowedSessionDirectory()` checks an eligible session's working directory. It does not confine every file that native tools can read. Selecting one project narrows session exposure; it is not a filesystem read allowlist.
- Native approvals can be answered through owner-scoped pending inline controls. Those controls provide request integrity and prevent stale/cross-topic answers; confirmation in the same compromised Telegram account is not an independent authentication factor. Not every native request is necessarily routed or replayed to this client.
- Assistant messages and live drafts are outbound data channels. Disabling file uploads or shell-network access alone does not prevent an agent from returning readable content through them. Native policy may independently deny the underlying read.
- The relay's private token/config ACLs and environment stripping reduce accidental exposure. They do not isolate credentials from an unrestricted process running as the same OS user. The relay process's own file reads must not become a way to bypass the native sandbox.

OpenAI documents filesystem and network permissions as distinct controls; a write-limited profile is not automatically a narrowly read-limited profile. Current permission profiles can define explicit `read`, `write` and `deny` entries, subject to platform enforcement. Effective profiles and compatibility with the targeted CLI must be checked locally, not inferred from a mode's name. [Permissions](https://learn.chatgpt.com/docs/permissions), [agent approvals/security](https://learn.chatgpt.com/docs/agent-approvals-security).

## Different compromises

| Attacker controls | Expected boundary and remaining risk |
| --- | --- |
| Unrelated Telegram account | Existing owner/private-chat checks reject messages and callbacks before processing; command visibility does not grant authority. |
| Paired owner's active Telegram session | Owner checks pass. The attacker can request native work and potentially answer requests delivered to Telegram, within effective native policy. Existing history and future deliveries in the account are exposed. |
| Bot token only | The bot itself is compromised: outgoing impersonation, interception/disruption of bot updates and access to files available to that bot are concerns. Possessing the token does not itself make incoming messages originate from the owner or grant an API to read arbitrary computer paths. Avoid using the bot token as a general local-export authorization credential. |
| Agent tool process or untrusted repository | Treat tool arguments and generated artifacts as untrusted. An exporter running with broader file access could become a confused deputy. Installation code, grants and settings must not be writable by the agent if they are intended to constrain it. |
| Host OS account/admin | Same-account or administrator compromise can defeat ordinary local code/config protections. Stronger guarantees need an actual OS/process security boundary; this is outside an owner-ID check. |

Telegram warns that a token grants control over the bot. Telegram cloud chats synchronize between logged-in devices and use client-server encryption rather than Secret Chat end-to-end encryption. Two-step verification helps prevent new unauthorized logins; it is not a relay-side distinction between an already stolen active session and a legitimate one. [Bot tokens](https://core.telegram.org/bots#how-do-i-create-a-bot), [Telegram FAQ](https://telegram.org/faq#q-how-do-you-encrypt-data), [two-step verification](https://telegram.org/faq#q-how-does-2-step-verification-work).

## Representative abuse paths

These are analytical scenarios, not executed attacks.

1. **Text leakage without uploads:** the compromised owner requests summaries or contents of accessible sensitive files; ordinary replies/drafts carry data. A small credential can leak in one message despite low quotas. **Mitigation owner: native execution policy and relay control design.** Constrain read access and offer a locally selected view-only mode; consider keeping native approval decisions local. Output keyword filters are not a reliable confinement mechanism.
2. **Export-folder laundering:** an agent with access to sensitive content copies or encodes it into an allowed output folder and requests export. **Mitigation owner: native policy plus export broker.** A folder, fresh timestamp, extension or content hash cannot prove that an artifact is nonsensitive. Restrict source access or require independent approval of the exact artifact.
3. **Path/identity substitution:** a path is checked, then its target or contents change before upload; links or aliases cross the intended boundary. **Mitigation owner: export broker.** Securely open a regular file, create a bounded protected snapshot and approve/send those exact bytes. Reject unsafe symlinks, Windows reparse points/junctions, special files, alternate data streams and unexpected hard links. `realpath` alone does not recognize sensitive content accessible through a hard link. Cross-platform enforcement needs adversarial tests.
4. **Overprivileged local tool:** a path-taking CLI/MCP exporter reads files using the relay process's privileges even when Codex could not read them. **Mitigation owner: local IPC/export broker.** Prefer narrow artifact capabilities and least-privileged file access. Authenticate local requests, bind them to the allowed native session/project and derive the recipient from saved state; the model cannot supply arbitrary chat IDs. Loopback networking alone is not caller authentication.
5. **Stale grants/offline sends:** a file changes after approval, a revoked grant remains queued, or a reconnect repeats a transfer whose outcome was uncertain. **Mitigation owner: export outbox.** Bind grants to snapshot hash/length, owner, session, destination, expiry and local policy version; use bounded one-time grants and recheck revocation before reading/sending. Persist delivery progress and do not blindly replay uncertain uploads. Already transmitted bytes cannot be recalled reliably.

OWASP recommends minimizing agent tools/permissions, avoiding open-ended tools, requiring approval for high-impact actions and enforcing authorization in downstream code rather than relying on the model. Guardrails and sensitive-keyword checks are not substitutes for these controls. [Excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/), [prompt-injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

## Three possible export modes

The following modes are design proposals. They are separate from whether Telegram may send new instructions or answer native approvals.

| Export mode | Video workflow | Protection if Telegram is stolen |
| --- | --- | --- |
| Locally published artifacts | The owner prepares/approves a finished video locally; Telegram can request only its short-lived opaque artifact ID. | Prevents arbitrary-path export through this feature. Previously published artifacts and native text channels remain exposed. Cannot automatically publish a newly generated unapproved file while the owner is away. |
| Independent per-artifact approval | The agent proposes a render; a trusted local UI or independent authenticated channel approves a protected snapshot, destination and expiry. | Strongest proposed upload-specific control against Telegram-only takeover, provided the agent cannot forge approval, alter broker code/grants or replace approved bytes. Costs an approval outside Telegram. A PIN stored in the same chat is insufficient. |
| Explicit trusted remote export | The owner locally enables automatic export from a narrow project output area with quotas and restricted native reads. | Convenient for unattended renders, but compromised Telegram can exercise the granted access. Folder/type/quota checks reduce scope and volume; they do not establish content confidentiality. Use only with accepted residual risk. |

Recommended default: outgoing export disabled until local opt-in, no arbitrary path or recursive/glob export, and no remote ability to widen roots, disable approval, select another recipient or enable export. Prefer locally published artifacts or independent approval for sensitive computers. A convenience mode must state clearly that Telegram compromise can expose all data the native agent/exporter is allowed to access.

A random artifact ID, digest or valid video container is not evidence that the bytes are safe. A shell-capable agent can create new media containing sensitive data. A MIME/extension allowlist and denylist of names such as `.env` are useful validation, not proof of provenance or confidentiality.

## Minimum implementation acceptance criteria

- Test with harmless synthetic files and mocked tools: an unrelated user, a stolen-owner simulation, cross-session/destination attempts, path traversal, absolute/UNC paths, link/reparse/hard-link aliases, special files, filename control characters and read/check/upload races. No real secrets are needed.
- Confirm that read-denied synthetic files cannot be read by shell, local image/file tools, MCP handlers, the exporter or a copied helper. Treat denied read policy as a platform-qualified control, not merely a prompt instruction.
- Demonstrate that copying readable secret-like synthetic data into an export folder is still possible in convenience mode; document this residual risk rather than presenting folder validation as a complete defense.
- Prove independent approval cannot be issued through Telegram, fabricated by model arguments, or forged by writes to agent-accessible configuration. Approve a hash/size-bound snapshot once; mutations, expiry, owner/session changes and local revocation invalidate the grant.
- Test nonblocking bounded uploads, quotas, shutdown/revoke during a pending send, restart/uncertain-delivery handling and snapshot expiry. Store operational metadata without file contents or credentials; protect audit records from the actor they are intended to monitor.
- Keep existing owner and topic checks, never disclose the bot token to the model, and avoid public network listeners. Explicitly document Telegram cloud retention and the inability to recover already disclosed data.

## Consequential decisions before implementation

1. Is the product a trusted full remote control or should it offer a view-only mode and locally required approval decisions?
2. Is the goal convenient unattended export, or resistance to takeover of the Telegram account? The latter requires a boundary independent of that account and may interrupt a fully remote workflow.
3. Should initial support be video/image artifacts only or arbitrary documents? Restricting types simplifies validation, but neither choice makes readable sensitive content safe automatically.
4. Which OS/native permission profiles are actually supported and verified for restricted reads? Do not silently strengthen or replace a user's native policy during installation.

No runtime permissions, processes, bot settings or release code were changed by this research.

## Product direction selected after this analysis

The owner chose the trusted remote-control model for personal computers or servers that remain accessible to their operator. Account-takeover risk is to be communicated clearly during setup and in documentation, with actionable Telegram account/device protection guidance. Mandatory independent approval of every file is not the default product direction. This accepts the residual account-compromise risk; it does not assert that Telegram settings stop an attacker already inside an authorized session, or that existing native/OS permission checks can be removed. A future exporter still needs deterministic owner/session/destination checks, safe file handling and bounded delivery. Outgoing files are not implemented by this documentation decision.

## Local evidence and limits

A harmless mocked simulation against the v0.1.15 Bridge confirmed that a stranger is rejected, the same instruction from the configured synthetic owner is accepted, and that synthetic owner can accept a currently delivered approval. Codex and Telegram were both test adapters: zero real native requests, zero real Telegram calls and zero private-file reads. This confirms the authentication boundary, not the readability of any real installation's files.

The senior-security STRIDE generator was run as a checklist for eight elements: Telegram authentication, relay control, native agent, export broker, artifact storage, relay state, outbound flow and Telegram cloud storage. Its generic catalogue/scores are not confirmed product vulnerabilities or measured attack probabilities; the project-specific abuse paths and mitigation owners above are the substantive assessment. A high-severity-pattern scan of `src` reported zero findings. It did not inspect private state, credentials, attachments, ignored files or the whole computer and is not a guarantee of secret absence or system safety. No mitigation is claimed implemented by this analysis.
