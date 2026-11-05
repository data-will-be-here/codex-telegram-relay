# Codex Telegram Relay

A local companion for your existing Codex sessions. Each session gets its own topic in a private chat with **your own Telegram bot**. Receive questions, approval requests and completed answers; reply from Telegram to the same native session.

https://github.com/user-attachments/assets/905562ec-fdfc-4e52-900c-61848ec2eaab

*40-second English demo · 16:9 · Fictional sessions and conversations. Native rich messages, headings and tables are included in v0.1.13.*

### Why use it?

- **Keep working away from your terminal.** Receive assistant updates, questions, approval requests and finished answers in Telegram; your replies reach the same Codex session.
- **Follow several projects at once.** Each session has its own project topic. Opt into automatic discovery to include new eligible terminal and IDE sessions as they appear.
- **Answer with buttons or your own words.** Structured questions offer inline choices; supported approvals have action buttons. You can also type a reply or provide attachment context.
- **Read formatted results.** Messages preserve Markdown emphasis, links, inline code and code blocks, including when a long answer spans several messages.
- **Get native rich messages.** Headings and tables render as Telegram rich messages, with repeated table headers and readable fallbacks for wide tables or unsupported formatting.
- **Send screenshots and documents as context.** Attach files in the project's topic and Codex receives them through its normal image/file inputs and permissions.
- **Receive generated files (development version).** After a one-time local opt-in, your agent can send a specific project file back to its session topic: MP4 as video, other files as documents.
- **Choose how much to receive.** Switch between all assistant messages and compact updates; shell output and file/tool events stay out of the chat.
- **Run locally with your own bot.** No VPS, webhook or public port is required. The relay accepts messages from its paired owner and keeps Codex's native approval and sandbox settings.

**Install with your coding agent:** send it the repository link and this prompt:

**For installation agents:** follow [Agent-assisted installation](#agent-assisted-installation) for both a bare repository URL and the prompt below. Explain account security to the user before pairing or starting the relay.

```text
Install Codex Telegram Relay on my computer: https://github.com/data-will-be-here/codex-telegram-relay/tree/main
Follow the README's "Agent-assisted installation" instructions. Before pairing or starting the relay, explain the remote-control risk and recommend the Telegram account/device protections in that workflow. Explain automatic discovery versus selected projects and ask which mode I want before configuring it. Complete local installation and help me pair my own Telegram bot. If the installed release supports file exports, offer to help add artifact-delivery instructions to my AGENTS.md. I will enter the token locally with hidden input; do not ask me to paste it into this chat.
```

[Русский README](README.ru.md)

[Public preview v0.1.16](https://github.com/data-will-be-here/codex-telegram-relay/releases/tag/v0.1.16). Includes live rich answer streaming, per-installation command menus and account-security guidance during installation. Qualified with Codex CLI 0.166.0; see the compatibility limits below.

`main` is the release branch; ongoing development and contribution PRs use `dev`. Install a version tag as shown below for a reproducible release.

## How it works

```text
Your Telegram bot / private project topics
                  ↕
     One relay process on your computer
                  ↕
     Existing local Codex shared daemon
                  ↕
        Your terminal / IDE sessions
```

- No VPS, webhook, public port or cloud relay to install.
- Each interactive terminal or IDE session gets its own topic; ephemeral contexts are excluded. On `dev`, approvals from verified spawned subagents appear in their root session's topic with the agent name and full ID, without creating child topics.
- Topics use the project plus a short session ID. Session routing uses saved IDs, independently of display names.
- Every message part starts with an italic `» project-name` signature, including project notices outside topics. General relay notices use `» codex-telegram-relay`.
- By default, all assistant messages are delivered. Command output, file/tool events and internal reasoning items are excluded.
- Replies immediately steer a running turn or start the next turn when idle.
- `/mode all` delivers all assistant commentary and final answers; `/mode compact` delivers the first reply to Telegram input and final answer. This owner-only preference applies to all sessions, persists and changes immediately for future messages.
- Assistant messages render Markdown emphasis, links and code; long answers preserve formatting across messages. Local file and preview links show their targets as text. A definite Telegram entity rejection falls back to plain text without repeating accepted parts.
- Live answer previews are enabled by default: eligible assistant text appears as it is generated, including native rich tables once their structure is available. `/stream off` disables previews; `/stream on` restores them immediately for all sessions. This setting persists independently of `/mode all|compact`. The complete response is saved separately through the durable outbox, even when a preview fails.
- Answers containing headings or tables use native Telegram rich messages. Long tables split between rows with repeated headers; wide tables and oversized cells use labelled paragraphs. A definite format rejection falls back to readable row cards. Short replies, questions and approval controls retain ordinary messages. This is independent of `/mode all|compact`.
  Oversized formatted blocks may simplify inline styling to preserve their complete text within Telegram's limits.
- Approval cards show the reason, working directory and exact command or change being requested, with relevant permission context and explicit action buttons.
  Commands containing carriage returns or other invisible control characters use a labelled JSON-escaped representation so those characters remain visible.
- Structured native questions show numbered choices, descriptions and inline answer buttons. You can also type an answer. Questions written only in ordinary assistant prose are delivered as text, without inferred buttons.
- Native sandbox, network, approval and instruction settings are inherited. On `dev`, `/model` explicitly changes the current session's model, reasoning effort and speed for following requests.
- Runtime npm dependencies are `ws` (native transport) and `marked` (Markdown parsing). SQLite comes with Node.

Previews share roughly one update per second across the private chat; simultaneous sessions and network delays can slow individual topics. Incomplete formatting may change layout while text arrives. Very long previews show their latest part, while permanent answers retain all parts within the existing 40,000 UTF-16-unit source limit. Drafts are temporary; permanent sends retain the existing uncertainty/recovery rules. [Streaming details](docs/architecture.md#live-answer-previews).

This is an initial developer release. Native transport, completion, questions, live steering and cross-client approval cancellation were qualified on Windows with CLI **0.166.0**, using a Telegram simulator. A real paired bot was subsequently checked for topic creation, bidirectional messages, formatting and native question responses. Sleep/reconnect, other native client versions and clean-machine installation still need acceptance checks. [Verification](docs/verification.md), [compatibility and limitations](docs/architecture.md).

## Requirements

- Node.js **22.13 or newer**; Node 24 LTS is recommended. Node 22 prints an experimental SQLite warning.
- A current, authenticated Codex CLI exposing `codex app-server proxy`, with a normal session already running. Send its first prompt before setup: an empty window has no resumable history yet.
- A dedicated bot created through [@BotFather](https://t.me/BotFather), with **private-chat topics enabled**.
- Your computer stays on and connected to the internet while you use the relay.

Install from the GitHub source release. No npm registry package is published.

## Install and pair

> **Account security:** This bot is remote control of Codex. Anyone controlling your paired Telegram account can act within the connected sessions' permissions and may obtain readable files or their contents. Protect the account, bot token and computer/server. Enable Telegram's cloud password (Two-Step Verification), an app passcode with auto-lock, and a device screen lock; review active sessions. The cloud password protects new logins, not an already unlocked session. See the [security guidance](SECURITY.md#protect-the-account-you-pair).

```sh
git clone --branch v0.1.16 https://github.com/data-will-be-here/codex-telegram-relay.git
cd codex-telegram-relay
npm ci
npm start -- doctor
npm start -- setup
npm start -- start
```

`npm ci` builds the TypeScript CLI. Setup asks you to select projects from your currently loaded Codex sessions, reads the bot token **without echoing it**, and prints a random pairing code. Send the displayed `/start CODE` to your bot in a **private** chat. The relay binds to the sender's numeric Telegram ID. Never paste a token into an issue, AI conversation or command argument.

Once running, the relay automatically creates a topic for each eligible session in your selected projects. Type in that topic to talk to its Codex session. Stop with Ctrl+C: the existing Codex daemon and its work keep running.

Topic names use the stable `project · ID` format. Routing uses saved native session IDs and Telegram topic IDs, independently of display names. Keep the private state directory when moving installations. The former status-title setting has been removed.

Discovery uses threads loaded in the shared daemon. This can include an older thread still waiting for approval even when its terminal/IDE window is no longer visible; it is not a list of open windows.

To stop relaying an old session without changing its Codex state, run `npm start -- sessions ignore SESSION_ID`, then restart the relay. A unique ID prefix from `/sessions` also works. Use `sessions unignore SESSION_ID` to reconnect it after another restart. Ignoring keeps the existing Telegram topic and history; topics are not automatically closed or deleted when a terminal window closes.

For an npm-style executable after cloning:

```sh
npm link
codex-telegram-relay doctor
codex-telegram-relay setup
codex-telegram-relay start
```

### Upgrade an existing installation

Development fix: newly opened sessions wait for their first local Codex message before the relay creates a topic. Existing saved topics explain this waiting state instead of reporting a connection failure. Readiness is retried automatically without submitting or replaying instructions.

Development reliability changes (after v0.1.16): observed final answers are saved before active-queue admission and survive overload/restart; `/status` shows pending finals. Saved final text consumes private disk until delivered or cancelled, so an extended outage can grow this backlog. Scope narrowing now cancels excluded queued output after restart. Discovery excludes subagents, ignored IDs and out-of-scope projects before counting its 64-session limit and warns when that limit is reached. Periodic scans run alongside message polling. Older versions do not handle the deferred backlog: clear it before downgrading.

Stop the relay with Ctrl+C, keeping Codex and the private relay state directory. Install the new version tag in a separate checkout using the commands above, then run `doctor` and `start` under the same OS account. If the bot is already paired, skip `setup`: the saved token, owner, topic bindings, ignored sessions and delivery progress are reused.

Use one relay process per private state directory. Version 0.1.13 adds durable rich-message delivery progress; older versions do not understand that progress. Do not downgrade while rich deliveries are pending or unresolved.

Version 0.1.14 enables live rich previews by default. After restarting the relay, use `/stream off` for completed messages only, or `/stream on` to restore streaming. Pairing and existing topic bindings are preserved; Codex sessions do not need restarting.

Version 0.1.15 synchronizes the command menu for your paired owner's chat during startup. Restart the relay after upgrading; no new pairing is required. Russian Telegram clients get Russian descriptions, with English as the fallback. Menu updates do not change who can access the relay.

### Agent-assisted installation

When installing this repository for a user, follow this workflow whether they supplied only its URL or copied the prompt above. The session-scope choice belongs to the user; a repository link alone does not authorize connecting every project.

**First, explain account security before pairing, changing session scope or starting the relay.** Send a short explanation in the user's language unless it has already been discussed in this installation conversation. State that a person controlling the paired Telegram account can instruct Codex and obtain data within its effective permissions, including on a connected server. Recommend Two-Step Verification/cloud password, a separate app passcode with auto-lock, device screen lock and review of active sessions. Explain that the cloud password protects new logins, not an already authorized/unlocked session. Use [SECURITY.md](SECURITY.md#protect-the-account-you-pair) for details; merely linking it or relying on setup's console warning does not complete this step. No separate risk-acceptance confirmation is required. Do not change the user's Telegram settings or native permissions yourself.

1. Check the OS, Git, Node.js 22.13+ and the existing authenticated Codex installation. Use its native executable, following the platform instructions below. Ask the user to start a normal session and send its first prompt if no eligible session is loaded. No server, webhook or MCP registration is needed.
2. Explain these two session-discovery modes and ask the user to choose, unless they already made that choice:
   - **Automatic (`all`)**: connects all eligible loaded interactive terminal/IDE sessions, including future projects, approximately every five seconds. Older interactive sessions retained by the daemon can also appear. Ignored sessions remain excluded. Subagents get no separate topics; on `dev`, their supported approvals can reach the attached root's topic.
   - **Selected projects (`selected`)**: connects sessions only inside locally chosen project directories; adding another project requires `projects add PATH` and a relay restart. Recommend automatic when the user wants every new project to appear; selected when they want a limited scope.
   Wait for their answer before pairing or changing session scope. This choice is separate from `/mode all|compact`, which controls how many assistant messages are delivered.
3. Read the release version in this README and install its version tag into a new local directory, using the clone command above. Run `npm ci` followed by `npm start -- doctor`. Report the installed version and commit. `main` contains release documentation; `dev` is for development and is not the installation source. Preserve any existing checkout changes and private relay state; do not reinstall by deleting configuration.
4. Help the user create a dedicated bot in @BotFather and enable private-chat topics. For a fresh installation, run `npm start -- setup --scope all` or `npm start -- setup --scope selected` according to their answer. If your terminal cannot accept private interactive input, have the user run that command in their own terminal. The token must be entered only into the hidden local prompt: never request it in chat, command arguments, environment variables or logs. The user sends the displayed `/start CODE` to their bot in a private chat; pairing must finish successfully.
5. For an already paired installation, skip setup. Run `npm start -- sessions scope all` or `npm start -- sessions scope selected` after their choice; selected mode needs at least one root added with `npm start -- projects add /absolute/path`. Keep the token, owner, ignored IDs and topic bindings intact.
6. Start one foreground relay with `npm start -- start`, or ask the user to restart their already running relay. Keep the process running; do not create an unattended service without a separate request. Confirm the startup discovery mode, matching `/status`, and a topic for an eligible session. In automatic mode, ask the user to open a session in a new project, send its first prompt and check its topic appears. If a real bot check is pending, report it as pending rather than claiming success.

For versions with outgoing files, explain that export is disabled by default and ask whether to enable it once locally with `files enable`. A person controlling the paired account can request files within Codex's effective permissions. Once enabled, individual files need no extra relay confirmation. Follow [Sending files back](#sending-files-back-development-version) when the user requests an artifact; `sent` is the success criterion.

7. **Offer to help update the user's `AGENTS.md`.** For an installed version with `send-file`, explain that this makes future agents deliver images, sketches, mockups, screenshots, videos and other review artifacts to the current session's Telegram topic. Offer a global user rule or a project-only rule, and show the proposed text with the actual local CLI path. Write it after the user chooses the scope or has already explicitly requested it; preserve existing instructions. A repository URL alone does not authorize changing global agent instructions. This documentation step does not enable file exports; respect the separate local opt-in. For older releases, explain the feature's availability rather than installing `dev` automatically.

Suggested rule, with placeholders resolved for that installation:

```text
When presenting a generated image, sketch, mockup, screenshot, animation, video or other review artifact in a relay-connected Codex session, send the actual file through Codex Telegram Relay's standard send-file command as part of presenting the result. Keep generated previews in an ignored artifact directory inside the current project. Use the installed CLI's absolute path:
node "<ABSOLUTE_RELAY_CLI_PATH>" send-file "<ABSOLUTE_PROJECT_ARTIFACT_PATH>" --session "<CURRENT_NATIVE_SESSION_ID>"
Route to the current interactive session. The CLI can use CODEX_THREAD_ID or a unique working-directory binding when --session is omitted; resolve ambiguity instead of guessing a topic. A local path or preview link can accompany the upload. Confirm delivery only when the receipt says sent; use files status REQUEST_ID for pending or uncertain results and inspect Telegram before any deliberate resend. Use existing export consent and native permissions; report disabled/unavailable export clearly. Keep the bot credential inside the relay and use this command rather than ad hoc Bot API scripts.
```

### Sending files back (development version)

This feature is on `dev`, **not in v0.1.16**. Use it after installing the version containing it and restarting the relay once. Pairing and existing topics are preserved. Enable exports locally on that computer/server:

```sh
npm start -- files enable
npm start -- send-file /absolute/project/path/demo.mp4 --session SESSION_ID
npm start -- files status REQUEST_ID
npm start -- files disable
```

`send-file` talks to the existing relay through a private SQLite queue; its process never reads the bot token. No extra server, MCP registration or poller is needed. MP4 is uploaded with Telegram's [sendVideo](https://core.telegram.org/bots/api#sendvideo); other files use [sendDocument](https://core.telegram.org/bots/api#senddocument). `--as document` preserves any file as a document, including images, audio, video and archives. The conservative per-file limit is **49,000,000 bytes**. Files must be inside the target session's project; links, hard links, special files, relay-private data, network paths and Windows alternate streams are rejected. This prevents accidental path escapes; it does not determine whether a file contains secrets.

**For agents:** invoke the installed CLI using its absolute path when working in another project, for example `node /absolute/relay/dist/src/cli.js send-file /absolute/project/report.pdf --session SESSION_ID`. The session defaults to `CODEX_THREAD_ID` when available, otherwise to the unique binding for the command's working directory. Specify `--session` when ambiguous; never choose an arbitrary topic. There is no caller-controlled chat ID. Native permission prompts for invoking the command still apply.

The command returns a JSON receipt and normally waits up to three minutes. Only `status: "sent"` with a message ID confirms delivery. Exit code 1 means rejected/uncertain; code 2 means the wait ended with work still pending. Save the request ID and inspect it with `files status ID`; `--no-wait` returns immediately. `--caption "text"` supplies a literal caption (up to 800 UTF-16 units) beneath the project signature.

An identical request deduplicates by session, destination, content and caption; successful/rejected receipts remain for seven days. An explicit `--request-id ID` must be reused for the same attempt and cannot be reused for different content. After `uncertain`, inspect Telegram before deliberately submitting a new ID: **no automatic replay** occurs after a timeout, crash or uncertain response. Uncertain receipts remain for inspection and contribute to `/status`.

Private snapshots freeze the queued bytes and are removed on completion/rejection/uncertainty. The queue allows 16 outstanding files and 200 MB of snapshots; unsent requests expire after ten minutes. A separate single-upload worker keeps message, question and button handling independent of slow network uploads. Disabling export blocks new/unstarted requests immediately; it cannot recall an upload already in flight. Neither the bot menu nor Telegram commands can enable export. These controls follow the [trusted remote-control model](SECURITY.md).

### Windows

The relay launches a **native `codex.exe`**, never a `.cmd`/`.bat` shell wrapper. It searches the npm Codex installation and the managed daemon package. If needed, pass the native executable explicitly:

```powershell
npm start -- doctor --codex-bin 'C:\absolute\path\to\codex.exe'
npm start -- setup --codex-bin 'C:\absolute\path\to\codex.exe'
```

### macOS and Linux

Executable links from Homebrew/native installers are resolved. For npm installations, the relay locates the actual platform binary behind `codex.js`, including hoisted and nested optional packages; the JavaScript/shell launcher is never executed by the relay. Unix execute permissions and ELF/Mach-O format are checked. CI installs official Codex 0.166.0 and checks its native version and proxy command on each OS; a complete real-session/Telegram exchange on macOS/Linux still needs acceptance testing.

### Automatically include new projects

Explicitly enable automatic discovery locally:

```sh
npm start -- sessions scope all
```

Restart the relay once. Every eligible loaded interactive session is then connected, including sessions in future projects, without another setup or restart. Discovery runs about every five seconds; a new session needs its first prompt before it has resumable history. This also includes IDE sessions and older interactive threads still loaded in the daemon. Explicitly ignored sessions and ephemeral contexts remain excluded. Subagents get no separate topics; on `dev`, their supported approvals can reach the attached root's topic.

For a fresh installation, `npm start -- setup --scope all` opts into the same mode. Plain `setup` and existing configurations retain selected-project discovery. `npm start -- sessions scope` shows the configured mode; `/status` shows the running mode. `npm start -- sessions scope selected` restores project restrictions after restarting. These settings can only be changed locally, not through Telegram.

### Add another project in selected mode

```sh
npm start -- projects add /absolute/path/to/project
```

Restart the relay afterwards. Project paths are resolved before containment checks, so a neighbouring directory with a similar name is not implicitly allowed.

## Telegram controls

Setup and each relay start synchronize the command menu with `setMyCommands` for the owner's private chat only, with English fallback and Russian descriptions. Each installation uses its own paired owner ID from local configuration. The same command list powers `/help`. Menu synchronization is optional: a failure does not stop message delivery, and the next start retries it. `doctor` remains read-only. Commands always require the configured owner in their private chat, even if someone types a command without seeing the menu.

| Input | Behaviour |
| --- | --- |
| Text in a project topic | Answer its pending question; otherwise steer the running turn or start a turn in the idle session |
| `/say TEXT` | Send an instruction even while a native question is pending |
| `/sessions` | Show the saved session/topic bindings |
| `/status` | Show connection and uncertain-delivery counts |
| `/mode`, `/mode all`, `/mode compact` | Show or change the assistant-message detail for all sessions; no restart required |
| `/stream`, `/stream on`, `/stream off` | Show or change live answer previews for all sessions; no restart required |
| `/bind SESSION_ID` | Recover uncertain creation, or retry attachment in the session's saved topic |
| `/repair SESSION_ID` | Explicitly retry a failed/uncertain topic creation after checking whether a topic appeared |
| `/questions` | Redisplay pending native questions |
| `/model` | Choose this session's model, reasoning effort and speed |
| `/help` | Show help |
| Approval buttons | Allow **once** or decline the specific pending native request |

The relay accepts only the paired owner in their private chat. Incoming attachments are handled as described below. There are no direct shell endpoints, bot commands for `/sandbox`, `/approval` or `/login`, new-session creation, or automatic history imports. Instructions sent to your session follow its existing Codex permissions.

On `dev`, `/model` in a connected session topic fetches the current native model catalog. Select a model, then a complete reasoning/speed option such as `High` or `Extra High · Fast`; that second selection saves immediately. Model names, supported reasoning levels and additional speed tiers come from Codex each time, with pages for longer lists. There are no Refresh or Apply buttons. Fast may use more subscription limits or credits; only advertised native tier IDs are offered. The setting applies to following requests in that same session, including local requests, while an already-running turn keeps its previous settings. History and native permissions are preserved. Reopen `/model` after relay reconnection; stale buttons expire and uncertain settings writes are never automatically repeated. [Protocol and verification](docs/architecture.md#session-model-selection).

## State and recovery

Configuration and state live outside your projects:

- Windows: `%LOCALAPPDATA%\codex-telegram-relay`
- Linux/macOS: `$XDG_CONFIG_HOME/codex-telegram-relay`, or `~/.config/codex-telegram-relay`

`config.json` stores the owner, discovery scope, project roots and native executable path. `bot.token` contains the token. `state.sqlite` stores topic bindings, delivery text and delivery status. Treat the entire directory as private. POSIX modes are restricted; setup/start verify current-user Windows access rules on private relay files.

The optional `CODEX_TELEGRAM_RELAY_HOME` environment variable changes this directory, for example for an isolated installation. No other environment variables are required.

A singleton lock prevents two relay instances using the same state directory. A Telegram polling conflict stops the relay rather than replacing another consumer. An existing webhook is never deleted automatically.

One temporarily unavailable Codex session does not stop discovery or relaying for healthy sessions. Native transport failures still reconnect. On `dev`, transient Telegram polling errors retry without restarting a healthy Codex connection; invalid credentials and competing pollers still stop the relay. During startup, temporary network/server failures in the bot identity or webhook checks retry after three seconds until Telegram recovers; a longer server rate-limit interval is respected. Ctrl+C stops startup retries.

On `dev`, replaying the same pending approval after reconnect or relay restart refreshes the existing card's buttons instead of posting another card. Distinct native requests and changed proposals remain separate. If the original send has no confirmed receipt, another copy is not sent automatically; answer that request in Codex. Existing cards from an older version lack the required identity, so the first replay after upgrading may create one new card. [Investigation and checks](docs/research/repeated-approval-cards-2026-11-05.md).

Topic creation is journaled before calling Telegram. If the response is lost, creation pauses to avoid duplicate topics, including after restarting the relay. The bot sends recovery instructions: use `/bind SESSION_ID` inside the topic if it appeared, or `/repair SESSION_ID` to explicitly retry if it did not. These commands require the paired owner and never submit an instruction to Codex.

A saved topic binding does not mean the native session is running. `/sessions` shows the saved topic number and relay attachment state. In that topic, `/bind SESSION_ID` or `/repair SESSION_ID` retries discovery and attachment of an eligible loaded session. If the session is unloaded, resume that exact conversation locally with `codex resume SESSION_ID` or reopen it in the IDE; the relay will reconnect automatically. A command in another topic identifies the saved destination without moving the binding. Creating another topic does not reload a native session.

If Telegram explicitly reports that a saved topic no longer exists, the relay recreates it for the loaded session and transfers queued undelivered answers. Existing sent history is not imported, and stale approval buttons are cancelled; pending native prompts are reattached with fresh controls. If you want to permanently remove a session's topic, ignore the session locally before deleting the topic.

Duplicate incoming updates do not execute twice. Writes with an ambiguous result are **not** automatically retried. Check the Codex terminal before repeating an instruction after an uncertainty notice. On reconnection, the relay catches up recent completions for saved bindings; it does not dump old history on the first attachment. See [delivery guarantees](docs/architecture.md).

## Development

Develop on `dev` or a feature branch targeting `dev`. Tested releases are promoted to `main` through a release PR; published version tags remain pinned to their release commits.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

CI runs tests on Windows, Linux and macOS with Node 22 and 24. Live model turns, credentials and real Telegram calls are excluded from CI. [Contributing](CONTRIBUTING.md), [security model](SECURITY.md).

This project is independent of OpenAI and Telegram. It uses the documented local [Codex App Server](https://learn.chatgpt.com/docs/app-server) and [Telegram Bot API](https://core.telegram.org/bots/api). MIT licensed.

## Incoming attachments and host questions

Send a photo, screenshot, document, voice/audio recording, video, video note or animation in its project topic. Downloads use Telegram getFile and its official HTTPS file endpoint; the token-bearing URL never reaches Codex. The cloud-download limit is 20 MiB per file. Files are kept in a private cache outside your checkout (200 MiB total, seven-day retention; expired files are cleaned on the next attachment). Captions are forwarded as user input. Albums are delivered as individual messages, not as one atomic prompt.

JPEG, PNG and WebP are passed as native localImage input; other files are supplied as local paths. Small UTF-8 files also include a bounded excerpt. Native questions accept attachment context as text/path; the agent may need its normal permission to inspect the file. The relay never executes or extracts uploads.

Audio/video files are received, but this version does not transcribe speech or extract video frames. That needs a separate local processor or an explicitly approved external service. File access and inspection still follow native Codex permissions; the relay does not widen them.

Native questions and supported approvals have buttons and text answers. Host request_user_input_async questions are read from the selected session journal because Codex 0.166.0 omits them from App Server items. The journal is streamed in 1 MiB chunks; only eligible question/answer records are retained, with a 256 KiB record limit. Large tool outputs do not truncate question recovery or produce warnings solely because of journal size. Answers are delivered as ordinary user input to the matching session; the host UI form may remain open. First attachment recovers the latest turn within seven days. Known unanswered questions extend that range across subsequent turns and reconnects, without importing unrelated earlier history. Sensitive/unsupported questions produce a terminal-required notice instead of forwarding private contents. A disconnected or stopped relay cannot send notices.

On `dev` (after v0.1.16), supported command, file-change and permission approvals from loaded spawned subagents are delivered to the attached root session's topic. Cards identify the agent by name and full ID. Pending requests are recovered by subscribing to each eligible child after reconnect or topic recovery; decisions answer the original child request once. Every ancestor must remain eligible. Child commentary, final answers and questions are not mirrored; direct Telegram instructions still address the interactive root. See [implementation and checks](docs/research/subagent-approvals-2026-11-05.md).

## Updating Codex and recovering its executable

If a Codex update removes the saved executable, restart the relay after starting your normal Codex sessions. The relay searches the supported native installation locations and saves a replacement path only after initialization and a successful shared-daemon session-list check. Pairing, bot token, session/topic IDs and native permissions are preserved. No CLI is downloaded, no alternate daemon is started, and no model turn is used for this check. Compatibility beyond the qualified Codex version still needs acceptance testing.

If discovery fails, select the installed native executable explicitly:

```sh
npm start -- start --codex-bin /absolute/path/to/native/codex
```

On Windows use an absolute path to codex.exe. An existing but invalid executable is rejected rather than silently replaced. doctor --codex-bin PATH can inspect a replacement without saving any configuration.

Known unanswered host questions now survive later turns and reconnects. Recovery extends only as far back as those known questions require; unrelated older questions are not imported. Very large questions and capacity limits produce terminal notices. Partial question answers are kept privately for up to seven days and restored only when stable identity and question contents match. A rejected native input remains retryable; accepted or uncertain input is not automatically repeated.
