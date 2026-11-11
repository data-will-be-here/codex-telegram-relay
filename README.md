# Codex Telegram Relay

[Русский README](README.ru.md)

A local companion for your existing Codex sessions. Each session gets its own topic in a private chat with **your own Telegram bot**. Receive questions, approval requests and completed answers; reply from Telegram to the same native session.

https://github.com/user-attachments/assets/905562ec-fdfc-4e52-900c-61848ec2eaab

*40-second English demo · 16:9 · Fictional sessions and conversations. Native rich messages, headings and tables are included in v0.1.13.*

### Why use it?

- **Start a separate conversation (v0.1.20).** `/new` works immediately: a general question/research workspace first, then connected projects. Each choice creates its own Codex session and Telegram topic.

- **Choose a model from Telegram.** `/model` opens the current Codex catalog; choose a model, then a reasoning/speed combination. The second selection saves immediately for following requests in the same session.
- **Optional live activity cards (v0.1.20).** `/view widgets` adds an updating activity card and the complete formatted final reply in a swipeable reader. Colors and text size follow the Telegram client's theme; approvals retain their normal controls.
- **Check remaining account limits (v0.1.20).** `/limits` reads current Codex usage windows, remaining percentages and reset times, with credit and spending information when available.
- **Keep working away from your terminal.** Receive assistant updates, questions, approval requests and finished answers in Telegram; your replies reach the same Codex session.
- **Keep a searchable conversation archive.** Messages forwarded under your chosen mode and your Telegram replies stay in the topic, so you can return to earlier discussions and results whenever you need them.
- **Follow several projects at once.** Each session has its own project topic. Opt into automatic discovery to include new eligible terminal and IDE sessions as they appear.
- **Answer with buttons or your own words.** Structured questions offer inline choices; supported approvals have action buttons. You can also type a reply or provide attachment context.
- **Read formatted results.** Messages preserve Markdown emphasis, links, inline code and code blocks, including when a long answer spans several messages.
- **Get native rich messages.** Headings and tables render as Telegram rich messages, with repeated table headers and readable fallbacks for wide tables or unsupported formatting.
- **Send screenshots and documents as context.** Attach files in the project's topic and Codex receives them through its normal image/file inputs and permissions.
- **Receive generated files (v0.1.17).** After a one-time local opt-in, your agent can send a specific project file back to its session topic: MP4 as video, other files as documents.
- **Choose how much to receive.** Switch between all assistant messages and compact updates; shell output and file/tool events stay out of the chat.
- **Run locally with your own bot.** No VPS, webhook or public port is required. The relay accepts messages from its paired owner and keeps Codex's native approval and sandbox settings.

**Install with your coding agent:** send it the repository link and this prompt:

**For installation agents:** follow [Agent-assisted installation](#agent-assisted-installation) for both a bare repository URL and the prompt below. Explain account security to the user before pairing or starting the relay.

```text
Install Codex Telegram Relay on my computer: https://github.com/data-will-be-here/codex-telegram-relay/tree/main
Follow the README's "Agent-assisted installation" instructions. Before pairing or starting the relay, explain the remote-control risk and recommend the Telegram account/device protections in that workflow. Explain automatic discovery versus selected projects and ask which mode I want before configuring it. Complete local installation and help me pair my own Telegram bot. If the installed release supports file exports, offer to help add artifact-delivery instructions to my AGENTS.md. I will enter the token locally with hidden input; do not ask me to paste it into this chat.
```

[Public preview v0.1.20](https://github.com/data-will-be-here/codex-telegram-relay/releases/tag/v0.1.20). Adds optional theme-aware activity widgets, complete swipeable result/status readers, native table attachments, same-topic `/clear`, and four Codex-style permission presets. Improves topic creation and recovery while keeping direct `npm start`, existing pairing and searchable Telegram history. Qualified with Codex CLI 0.166.0; see the compatibility limits below.

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
- Each interactive terminal or IDE session gets its own topic; ephemeral contexts are excluded. In v0.1.17, approvals from verified spawned subagents appear in their root session's topic with the agent name and full ID, without creating child topics.
- Topics use the project plus a short session ID. Session routing uses saved IDs, independently of display names.
- Since v0.1.18, session output starts with an italic `» project-name • session-name` signature; unnamed sessions use a short session ID. Names come from Codex. General relay notices use `» codex-telegram-relay`.
- By default, all assistant messages are delivered. Command output, file/tool events and internal reasoning items are excluded.
- Replies immediately steer a running turn or start the next turn when idle.
- `/mode all` delivers all assistant commentary and final answers; `/mode compact` delivers the first reply to Telegram input and final answer. This owner-only preference applies to all sessions, persists and changes immediately for future messages.
- Assistant messages render Markdown emphasis, links and code; long answers preserve formatting across messages. Local file and preview links show their targets as text. A definite Telegram entity rejection falls back to plain text without repeating accepted parts.
- Live answer previews are enabled by default: eligible assistant text appears as it is generated, including native rich tables once their structure is available. `/stream off` disables previews; `/stream on` restores them immediately for all sessions. This setting persists independently of `/mode all|compact`. The complete response is saved separately through the durable outbox, even when a preview fails.
- Answers containing headings or tables use native Telegram rich messages. Long tables split between rows with repeated headers; wide tables and oversized cells use labelled paragraphs. A definite format rejection falls back to readable row cards. Short replies, questions and approval controls retain ordinary messages. This is independent of `/mode all|compact`.
  Oversized formatted blocks may simplify inline styling to preserve their complete text within Telegram's limits.
- Approval cards show the reason, working directory and command or change being requested, with relevant permission context and explicit action buttons. Large embedded code can use a clearly marked abbreviated preview; the button still approves the full original command available in Codex.
  Commands containing carriage returns or other invisible control characters use a labelled JSON-escaped representation so those characters remain visible.
- Structured native questions show numbered choices, descriptions and inline answer buttons. You can also type an answer. Questions written only in ordinary assistant prose are delivered as text, without inferred buttons.
- Native sandbox, network, approval and instruction settings are inherited. `/model` explicitly changes this session's model settings; `/permissions` (v0.1.20) explicitly changes its permission profile or approval reviewer for following requests.
- Runtime npm dependencies are `ws` (native transport) and `marked` (Markdown parsing). SQLite comes with Node.

Previews share roughly one update per second across the private chat; simultaneous sessions and network delays can slow individual topics. Incomplete formatting may change layout while text arrives. Very long previews show their latest part, while permanent answers retain all parts within the existing 40,000 UTF-16-unit source limit. Drafts are temporary; permanent sends retain the existing uncertainty/recovery rules. [Streaming details](docs/architecture.md#live-answer-previews).

This remains a public preview. Native transport, completion, questions, live steering and cross-client approval cancellation were qualified on Windows with CLI **0.166.0**, using a Telegram simulator. A real paired bot was subsequently checked for topic creation, bidirectional messages, formatting and native question responses. Sleep/reconnect, other native client versions and clean-machine installation still need acceptance checks. [Verification](docs/verification.md), [compatibility and limitations](docs/architecture.md).

## Requirements

- Node.js **22.13 or newer**; Node 24 LTS is recommended. Node 22 prints an experimental SQLite warning.
- A current, authenticated Codex CLI exposing `codex app-server proxy`, with a normal session already running. Send its first prompt before setup: an empty window has no resumable history yet.
- A dedicated bot created through [@BotFather](https://t.me/BotFather), with **private-chat topics enabled**.
- Your computer stays on and connected to the internet while you use the relay.

Install from the GitHub source release. No npm registry package is published.

## Install and pair

> **Account security:** This bot is remote control of Codex. Anyone controlling your paired Telegram account can act within the connected sessions' permissions and may obtain readable files or their contents. Protect the account, bot token and computer/server. Enable Telegram's cloud password (Two-Step Verification), an app passcode with auto-lock, and a device screen lock; review active sessions. The cloud password protects new logins, not an already unlocked session. See the [security guidance](SECURITY.md#protect-the-account-you-pair).

```sh
git clone --branch v0.1.20 https://github.com/data-will-be-here/codex-telegram-relay.git
cd codex-telegram-relay
npm ci
npm start -- doctor
npm start -- setup
npm start
```

Since v0.1.19, `npm start` starts the relay directly. Use `npm start -- --help` for help or `npm start -- --codex-bin /absolute/path/to/native/codex` to select its executable. The explicit `npm start -- start` remains supported.

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

**Before upgrading to v0.1.20, stop the relay and back up its complete private state directory** (including SQLite sidecar files, configuration and pairing). Keep that backup private. This release automatically extends the state schema and stores mixed widget/table/file delivery plans, status snapshots and new-session/reset state. **In-place downgrade to v0.1.19 or older is unsupported even after queues drain**: old code cannot use the upgraded database layout. For rollback, stop every relay process and restore a compatible pre-upgrade backup; restoring it does not undo later Telegram/Codex actions, so reconcile post-backup deliveries and sessions before restarting. Prefer a forward fix if newer state must be preserved.

Since v0.1.20, newly opened sessions wait for their first local Codex message before the relay creates a topic. Existing saved topics explain this waiting state instead of reporting a connection failure. Readiness is retried automatically without submitting or replaying instructions.

Delivery reliability: observed final answers are saved before active-queue admission and survive overload/restart; `/status` shows pending finals. Saved final text consumes private disk until delivered or cancelled, so an extended outage can grow this backlog. Scope narrowing now cancels excluded queued output after restart. Discovery excludes subagents, ignored IDs and out-of-scope projects before counting its 64-session limit and warns when that limit is reached. Periodic scans run alongside message polling. Older versions do not handle the deferred backlog; do not use them with this release's state.

Stop the relay with Ctrl+C, keeping Codex and the private relay state directory. Install the new version tag in a separate checkout using the commands above, then run `doctor` and `start` under the same OS account. If the bot is already paired, skip `setup`: the saved token, owner, topic bindings, ignored sessions and delivery progress are reused.

Use one relay process per private state directory. Version 0.1.13 adds durable rich-message delivery progress; older versions do not understand that progress. Do not downgrade while rich deliveries are pending or unresolved.

Version 0.1.14 enables live rich previews by default. After restarting the relay, use `/stream off` for completed messages only, or `/stream on` to restore streaming. Pairing and existing topic bindings are preserved; Codex sessions do not need restarting.

Version 0.1.15 synchronizes the command menu for your paired owner's chat during startup. Restart the relay after upgrading; no new pairing is required. The v0.1.20 UI uses English throughout; startup also replaces the legacy Russian command descriptions with English. Menu updates do not change who can access the relay.

### Agent-assisted installation

When installing this repository for a user, follow this workflow whether they supplied only its URL or copied the prompt above. The session-scope choice belongs to the user; a repository link alone does not authorize connecting every project.

**First, explain account security before pairing, changing session scope or starting the relay.** Send a short explanation in the user's language unless it has already been discussed in this installation conversation. State that a person controlling the paired Telegram account can instruct Codex and obtain data within its effective permissions, including on a connected server. Recommend Two-Step Verification/cloud password, a separate app passcode with auto-lock, device screen lock and review of active sessions. Explain that the cloud password protects new logins, not an already authorized/unlocked session. Use [SECURITY.md](SECURITY.md#protect-the-account-you-pair) for details; merely linking it or relying on setup's console warning does not complete this step. No separate risk-acceptance confirmation is required. Do not change the user's Telegram settings or native permissions yourself.

1. Check the OS, Git, Node.js 22.13+ and the existing authenticated Codex installation. Use its native executable, following the platform instructions below. Ask the user to start a normal session and send its first prompt if no eligible session is loaded. No server, webhook or MCP registration is needed.
2. Explain these two session-discovery modes and ask the user to choose, unless they already made that choice:
   - **Automatic (`all`)**: connects all eligible loaded interactive terminal/IDE sessions, including future projects, approximately every five seconds. Older interactive sessions retained by the daemon can also appear. Ignored sessions remain excluded. Subagents get no separate topics; in v0.1.17, their supported approvals can reach the attached root's topic.
   - **Selected projects (`selected`)**: connects sessions only inside locally chosen project directories; adding another project requires `projects add PATH` and a relay restart. Recommend automatic when the user wants every new project to appear; selected when they want a limited scope.
   Wait for their answer before pairing or changing session scope. This choice is separate from `/mode all|compact`, which controls how many assistant messages are delivered.
3. Read the release version in this README and install its version tag into a new local directory, using the clone command above. Run `npm ci` followed by `npm start -- doctor`. Report the installed version and commit. `main` contains release documentation; `dev` is for development and is not the installation source. Preserve any existing checkout changes and private relay state; do not reinstall by deleting configuration.
4. Help the user create a dedicated bot in @BotFather and enable private-chat topics. For a fresh installation, run `npm start -- setup --scope all` or `npm start -- setup --scope selected` according to their answer. If your terminal cannot accept private interactive input, have the user run that command in their own terminal. The token must be entered only into the hidden local prompt: never request it in chat, command arguments, environment variables or logs. The user sends the displayed `/start CODE` to their bot in a private chat; pairing must finish successfully.
5. For an already paired installation, skip setup. Run `npm start -- sessions scope all` or `npm start -- sessions scope selected` after their choice; selected mode needs at least one root added with `npm start -- projects add /absolute/path`. Keep the token, owner, ignored IDs and topic bindings intact.
6. Start one foreground relay with `npm start`, or ask the user to restart their already running relay. Keep the process running; do not create an unattended service without a separate request. Confirm the startup discovery mode, matching `/status`, and a topic for an eligible session. In automatic mode, ask the user to open a session in a new project, send its first prompt and check its topic appears. If a real bot check is pending, report it as pending rather than claiming success.

For versions with outgoing files, explain that export is disabled by default and ask whether to enable it once locally with `files enable`. A person controlling the paired account can request files within Codex's effective permissions. Once enabled, individual files need no extra relay confirmation. Follow [Sending files back](#sending-files-back) when the user requests an artifact; `sent` is the success criterion.

7. **Offer to help update the user's `AGENTS.md`.** For an installed version with `send-file`, explain that this makes future agents deliver images, sketches, mockups, screenshots, videos and other review artifacts to the current session's Telegram topic. Offer a global user rule or a project-only rule, and show the proposed text with the actual local CLI path. Write it after the user chooses the scope or has already explicitly requested it; preserve existing instructions. A repository URL alone does not authorize changing global agent instructions. This documentation step does not enable file exports; respect the separate local opt-in. For older releases, explain the feature's availability rather than installing `dev` automatically.

Suggested rule, with placeholders resolved for that installation:

```text
When presenting a generated image, sketch, mockup, screenshot, animation, video or other review artifact in a relay-connected Codex session, send the actual file through Codex Telegram Relay's standard send-file command as part of presenting the result. Keep generated previews in an ignored artifact directory inside the current project. Use the installed CLI's absolute path:
node "<ABSOLUTE_RELAY_CLI_PATH>" send-file "<ABSOLUTE_PROJECT_ARTIFACT_PATH>" --session "<CURRENT_NATIVE_SESSION_ID>"
Route to the current interactive session. The CLI can use CODEX_THREAD_ID or a unique working-directory binding when --session is omitted; resolve ambiguity instead of guessing a topic. A local path or preview link can accompany the upload. Confirm delivery only when the receipt says sent; use files status REQUEST_ID for pending or uncertain results and inspect Telegram before any deliberate resend. Use existing export consent and native permissions; report disabled/unavailable export clearly. Keep the bot credential inside the relay and use this command rather than ad hoc Bot API scripts.
```

<a id="sending-files-back"></a>
<a id="sending-files-back-development-version"></a>

### Sending files back (v0.1.17)

This feature is in v0.1.17, **not in v0.1.16**. Use it after installing the version containing it and restarting the relay once. Pairing and existing topics are preserved. Enable exports locally on that computer/server:

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

Restart the relay once. Every eligible loaded interactive session is then connected, including sessions in future projects, without another setup or restart. Discovery runs about every five seconds; a new session needs its first prompt before it has resumable history. This also includes IDE sessions and older interactive threads still loaded in the daemon. Explicitly ignored sessions and ephemeral contexts remain excluded. Subagents get no separate topics; in v0.1.17, their supported approvals can reach the attached root's topic.

For a fresh installation, `npm start -- setup --scope all` opts into the same mode. Plain `setup` and existing configurations retain selected-project discovery. `npm start -- sessions scope` shows the configured mode; `/status` shows the running mode. `npm start -- sessions scope selected` restores project restrictions after restarting. These settings can only be changed locally, not through Telegram.

### Add another project in selected mode

```sh
npm start -- projects add /absolute/path/to/project
```

Restart the relay afterwards. Project paths are resolved before containment checks, so a neighbouring directory with a similar name is not implicitly allowed.

## Telegram controls

The v0.1.20 interface uses English for all relay-generated menus, buttons, notifications and approval-preview warnings, regardless of the Telegram app language. User messages, Codex replies, question options and native descriptions keep their original language.

Setup and each relay start synchronize the English command menu with `setMyCommands` for the owner's private chat only, including the legacy Russian scope so existing installations stop showing mixed languages. Each installation uses its own paired owner ID from local configuration. The same command list powers `/help`. Menu synchronization is optional: a failure does not stop message delivery, and the next start retries it. `doctor` remains read-only. Commands always require the configured owner in their private chat, even if someone types a command without seeing the menu.

| Input | Behaviour |
| --- | --- |
| Text in a project topic | Answer its pending question; otherwise steer the running turn or start a turn in the idle session |
| `/sessions` | Show the saved session/topic bindings |
| `/new` | Create a conversation without a project, or in a connected project (v0.1.20) |
| `/clear` | Start a fresh conversation in this topic, preserving Telegram history (v0.1.20) |
| `/status` | Show connection and uncertain-delivery counts |
| `/limits` | Show fresh account limits and reset times (v0.1.20) |
| `/mode`, `/mode all`, `/mode compact` | Show or change the assistant-message detail for all sessions; no restart required |
| `/stream`, `/stream on`, `/stream off` | Show or change live answer previews for all sessions; no restart required |
| `/bind SESSION_ID` | Recover uncertain creation, or retry attachment in the session's saved topic |
| `/repair SESSION_ID` | Explicitly retry a failed/uncertain topic creation after checking whether a topic appeared |
| `/questions` | Redisplay pending question cards with answer buttons and free-text input |
| `/model` | Choose this session's model, reasoning effort and speed |
| `/permissions` | Show and change this session's native permissions (v0.1.20) |
| `/view`, `/view classic`, `/view widgets` | Choose Classic or experimental Widgets for all topics (v0.1.20) |
| `/help` | Show help |
| Approval buttons | Allow **once** or decline the specific pending native request |

The relay accepts only the paired owner in their private chat. Incoming attachments are handled as described below. There are no direct shell endpoints, account-login commands or automatic history imports. New conversations use an automatically prepared workspace or known projects within the current discovery scope. Instructions follow the session's effective native Codex permissions; only an explicit `/permissions` selection changes them.

Since v0.1.18, the main command menu is simplified. Ordinary text answers a pending question; with several pending questions, select “Type an answer” on the intended card first. `/questions` brings those cards back with working choice buttons; it does not merely list their titles. `/bind` and `/repair` remain available through help/manual input but are hidden from the main command menu.

Topic-creation failure notices offer “Topic appeared — bind” and “Topic did not appear — create again” buttons. The first selects the session: open the topic that appeared and send `/bind` without an ID within ten minutes. Telegram does not provide the unknown destination topic ID through the original notice button. The second explicitly retries creation. Both require current owner authorization and a live eligible session; stale attempts cannot create another topic.

In v0.1.17, `/model` in a connected session topic fetches the current native model catalog. Select a model, then a complete reasoning/speed option such as `High` or `Extra High · Fast`; that second selection saves immediately. Model names, supported reasoning levels and additional speed tiers come from Codex each time, with pages for longer lists. There are no Refresh or Apply buttons. Fast may use more subscription limits or credits; only advertised native tier IDs are offered. The setting applies to following requests in that same session, including local requests, while an already-running turn keeps its previous settings. History and native permissions are preserved. Reopen `/model` after relay reconnection; stale buttons expire and uncertain settings writes are never automatically repeated. [Protocol and verification](docs/architecture.md#session-model-selection).

## Experimental activity widgets (v0.1.20)

Send `/view` in any topic or directly in the bot chat and choose `Classic` or `Widgets · experimental`, or use `/view widgets` directly. Classic is the default. One relay-wide preference applies to all current and future sessions and survives restarts. It applies to following turns; running turns keep their original view. `/view classic` restores the classic view for all topics. On first upgrade from per-session preferences, Widgets is retained if any saved session had it enabled; later global choices take precedence. `/status` shows the shared view. No local opt-in, separate web server or Telegram Mini App setup is needed.

A turn lasting more than about a second can produce one activity card. It updates in place with the project/task, status, elapsed time, structured-plan counters, a brief assistant progress summary and up to three recent actions. Safe details distinguish file basenames, known command runners and tool names; raw command arguments, tool payload/output and reasoning are excluded. Failed commands do not automatically label the whole turn failed. No iteration budget, ETA or overall percentage is invented. Native task/plan text keeps its language; service labels are English.

The card uses Telegram's message-bubble palette and native text tokens, including live theme/font changes and safe-area insets. Larger fonts reduce detail. The live progress preview converts Markdown to readable plain text before applying its byte budget; full formatting remains in Current status. Progress text uses the available data budget, ends at a sentence or word with an explicit ellipsis when shortened, and has a local More/Less control when more loaded text fits. Current status opens the complete saved progress explanation in a separate immutable widget, using the result reader's local pages or sequential overflow parts. It is a snapshot at the time of the click, titled Current status with a neutral blue marker. Repeating a click on the same revision reuses its delivery; a newer revision can open a new snapshot. The last part offers Text version. Existing Current step buttons open the same reader. It is a fixed, sandboxed mini-HTML template with bounded private `chat_data`, no external assets, shared state or widget-origin requests. Files, questions and full approvals keep their existing delivery paths. The card does not approve, change permissions or interrupt work.

`/view` preserves the saved `/mode` and `/stream` preferences. During a widget turn, commentary and answer drafts stay out of ordinary text messages. Completion first tries an entire table-free formatted reply in one result widget, with local swipe/arrows and a current/total page counter. If that full reader exceeds the measured 32768-source-byte or 4000-zlib9-byte budget, the entire reply instead becomes short sequential widget parts: read them by scrolling the chat, with no pages or horizontal navigation inside a part. A table-free reply can exceed the byte budget even when its text is visually short: the fixed reader code also counts. Overflow parts use a larger density budget and choose the latest useful paragraph or complete-sentence boundary, preserving all text. Each flow card shows its complete part; on narrow screens or very large client text it reduces the body font only as needed (down to 12px) to stay within Telegram's 600px ceiling. Replies containing Markdown tables use an ordered mixed result: text widgets before a table, a native rich-table message, then text widgets after it. All text widgets in that mixed reply read vertically without inner pages. Tables retain rows, columns, headers, emphasis, code and supported links; long tables split by rows with repeated headers. Tables beyond the safe native limits, or definitely rejected by Telegram, use complete generated HTML attachments rather than labeled prose. The attachments contain only reply data, with no local source-file reads. Ordinary text mode is unchanged. Only the first message shows completion and enables a notification, including replies beginning with a table or HTML file; widget part numbers retain their position in the delivery sequence. The project label wraps at the upper left while the part number stays at the upper right. Native tables and HTML attachments omit the project/Part header and instead show only Attachment N · Table. All text is embedded in immutable HTML and remains readable with the relay offline, without a model turn. Activity cards keep More/Less.

The last result part offers Text version as an optional formatted text copy; existing Full answer buttons continue working. That copy requires the relay and its saved state. A definite widget rejection switches remaining unsent parts to text. Unknown sends are never replayed and use one complete text backup; already acknowledged result parts are not reposted. New questions/approval controls take priority over continuing a long result series. A failed activity card releases its latest suppressed summary once.

Full-answer caches are private local state retained independently of the seven-day delivery queue, so old buttons remain usable while their exact topic/project binding remains eligible. Up to 10,000 replies are retained; at capacity new results use ordinary text instead of discarding old answers. Removing the local state removes this archive and its buttons' content.

The implementation targets production Bot API 10.4/private topics. New activity cards have a Classic for all topics button and no explanatory caption beneath them. Rendering depends on the Telegram client. Quiet active cards are checked against recent native history, at most four per discovery pass and no more often than every 15 seconds per card, with bounded RPC timeouts. A missed completion settles the existing card and delivers the final reply once without regressing a newer baseline. Successful checks refresh live status; finished cards show a stable Finished footer. Unknown initial sends are never replayed, and uncertain receipts remain protected from pruning. Existing sent HTML is immutable: the new footer/layout applies to new cards; editing data cannot upgrade the old template. [Protocol and validation](docs/architecture.md#activity-widgets).

Proven connection failures before a widget request is sent are retried after three seconds. If an initial send has an unknown outcome, it is never replayed automatically and Classic is selected for following turns in all topics. `/view widgets` enables future cards. Safe diagnostic categories are retained locally; raw transport errors and bot URLs are not stored.

## Session permissions with /permissions (v0.1.20)

Send `/permissions` in an attached session topic to see its current settings and a fresh catalog of allowed native profiles. No local opt-in is needed; Codex must support the native profile/settings APIs. The menu matches the CLI: Ask for approval, Approve for me, Full Access and Read Only, followed by custom profiles. Only choices allowed by the native catalog, feature flags and managed requirements are offered.

An ordinary profile applies on selection. Full Access first shows a warning and requires separate confirmation: local commands may modify files outside the project and access the network without approval prompts. Custom profiles also require confirmation with their native description. Changes persist for following requests in this same session, including local requests. An active turn or pending approval, other sessions and global configuration are unaffected.

Ask for approval selects the workspace profile with user approval review. Approve for me selects the same workspace profile with native automatic review; it does not grant Full Access. Both use on-request approval policy. Full Access selects unrestricted access with no approval prompts; Read Only selects the read-only profile with on-request user review. Each standard choice applies the complete profile/policy/reviewer preset, and the current marker compares all three. Custom profiles preserve the existing policy and reviewer. Codex remains authoritative.

Opening, paging and cancelling never change settings. Buttons expire after ten minutes and belong only to the original message, topic and connection. A local settings change invalidates an earlier selection. Unknown write outcomes are never automatically repeated: check permissions in Codex before another selection. [Protocol and verification](docs/architecture.md#session-permission-selection).

## Fresh conversation in the current topic: /clear (v0.1.20)

Send `/clear` without arguments in a saved session topic to start a new empty conversation in the same canonical directory. Telegram messages and the previous native transcript remain available. No new Telegram topic is created and no model task is started. An open terminal stays on the previous native session; the bot reports the new session ID. The new conversation uses Codex's project/default model and permissions, and the relay-wide Classic/Widgets preference is preserved. A verified non-archived unloaded conversation can also be cleared without resuming its old terminal; active work, pending input, deliveries and unverifiable history still block the switch. Refusals identify the concrete blocker.

The current session must be idle, with no pending questions/approvals or queued deliveries/uploads. During the switch new input and settings controls are blocked. A definite creation rejection keeps the original topic usable. Unknown creation outcomes are reconciled by an operation marker without replaying creation; known IDs survive attachment or local persistence failures. After the atomic handoff the old session is excluded from automatic relay discovery and its old controls cannot change the new session. Saved Full answer buttons remain readable in the same eligible topic/project lineage. Native files/history are not deleted, archived or reverted. Explicitly moved or unrelated topic bindings invalidate the historical read route.

## New conversations with /new (v0.1.20)

`/new` works out of the box, including existing installations without a `newSessions` configuration section. The relay automatically prepares `codex-telegram-conversations` beside its private data directory, keeping workspace files separate from the bot token and state database. If that location lies inside a Git repository, the default is `~/Codex/Conversations`. No `new enable` or manual directory creation is required.

The project picker uses selected roots and previously connected projects within the current discovery scope. Ignored sessions and scratch UUID directories are excluded. Arbitrary paths cannot be supplied from Telegram. Existing explicit custom settings and a deliberate `new disable` remain respected.

Optional local customization, followed by a relay restart:

```sh
npm start -- new enable --project /absolute/path/to/project
npm start -- new enable --scratch-root /absolute/path/to/conversations
```

Use canonical absolute directories for overrides. Keep scratch outside Git repositories, project roots, relay private data and `CODEX_HOME`. `npm start -- new` shows effective settings; `new disable` disables new creation while keeping existing conversations usable. These commands are optional; updating an existing relay requires only loading the updated code, not a new setup step.

Send `/new` in any owner-private topic, an unbound topic, or without a topic. The first option is **No project — question / research** (a general conversation), followed by the current available project and other known projects. Long lists have pages and Cancel. Choosing a location starts creation immediately; there is no Apply step. Open the new topic and write the first task there. Text in the old topic continues to its original session, including pending questions and approvals.

Each general conversation uses a persistent `<scratchRoot>/<operation-id>` directory for reports, downloads and scripts. Chat history is separate because it is a new thread. Global Codex settings, skills, plugins, instructions and memory remain shared. Directories are retained for resumption and file export, not auto-deleted. Titles/headers use **No project**; UUID directories are not added to the project picker. Project sessions share the project's files and current Git branch; `/new` creates no worktree and copies no conversation history.

The relay first creates and confirms a Telegram topic. Only then does it create the Codex session through the existing connection (`thread/start` then `thread/name/set`), without a synthetic prompt or model turn. A failed or unknown topic request creates no Codex session. The menu offers explicit retry, cancellation, or selection of an existing empty topic followed by `/bind`. Proven pre-connect failures retry after three seconds; unknown requests never replay automatically. `/model` is available before the first task. Ordinary cold terminal sessions still require their first local message. Native permissions, model defaults and project configuration are inherited; Codex may initialize project trust under its own rules.

The computer, relay and background Codex process must be running; a terminal window per conversation and the Windows GUI app are unnecessary. The current proxy does not start the daemon. Creation runs beside messaging and uploads. Duplicate clicks cannot repeat a start. Lost responses are reconciled by exact operation metadata, never automatically retried as a new start. Known IDs survive naming/topic failures; uncertain Telegram topic creation uses `/bind` and `/repair`. Archived sessions are not unarchived or replaced. [Protocol and recovery](docs/architecture.md#new-conversation-creation).

For older operations that already created a Codex session before its topic, the original `/new` menu shows the saved session ID and recovery actions. Repeating `/new` returns to those actions. Recovery reuses that same native session; it never creates a replacement. Existing saved sessions are retained.

Recovery controls can restore an unloaded conversation created by `/new` from its exact saved ID, after verifying its non-archived history and allowed workspace. A terminal prompt is not required. Ordinary unowned terminal sessions keep their existing readiness checks. `BOT_TOPIC_WRONG_HOME` is treated as an unknown creation outcome: check Telegram before retrying, since an error response is not proof that no topic is visible. The relay never derives topic IDs from names or message IDs.

## Account limits


Available since v0.1.20, `/limits` works in the paired owner's private chat and any topic, including one without an attached session. Each invocation reads `account/rateLimits/read` through the existing native connection and replies in the same place. The limits belong to the active Codex account, not the individual session. No model turn is created.

The response shows the actual quota groups and window durations returned by Codex; it does not assume both a five-hour and a weekly window exist. Remaining percentages, reset dates in the relay computer's explicitly labelled timezone, relative time, and the snapshot time are displayed. Plan, credits and spending restrictions appear when provided; a backend-reported restriction remains visible even with a positive percentage. Unknown fields stay unavailable, and a passed reset timestamp does not imply recovered quota. Very large lists are explicitly shortened. Repeat `/limits` for a fresh snapshot; there are no background alerts.

This is Codex's account-usage view, not an API billing lookup. Unsupported authentication modes, unavailable methods and read failures produce an explanatory reply without restarting the relay or exposing raw backend errors. Restart the updated relay to load the command and synchronize its menu. [Official contract](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

## State and recovery

Configuration and state live outside your projects:

- Windows: `%LOCALAPPDATA%\codex-telegram-relay`
- Linux/macOS: `$XDG_CONFIG_HOME/codex-telegram-relay`, or `~/.config/codex-telegram-relay`

`config.json` stores the owner, discovery scope, project roots and native executable path. `bot.token` contains the token. `state.sqlite` stores topic bindings, delivery text and delivery status. Treat the entire directory as private. POSIX modes are restricted; setup/start verify current-user Windows access rules on private relay files.

The optional `CODEX_TELEGRAM_RELAY_HOME` environment variable changes this directory, for example for an isolated installation. No other environment variables are required.

A singleton lock prevents two relay instances using the same state directory. A Telegram polling conflict stops the relay rather than replacing another consumer. An existing webhook is never deleted automatically.

One temporarily unavailable Codex session does not stop discovery or relaying for healthy sessions. Native transport failures still reconnect. In v0.1.17, transient Telegram polling errors retry without restarting a healthy Codex connection; invalid credentials and competing pollers still stop the relay. During startup, temporary network/server failures in the bot identity or webhook checks retry after three seconds until Telegram recovers; a longer server rate-limit interval is respected. Ctrl+C stops startup retries.

In v0.1.17, replaying the same pending approval after reconnect or relay restart refreshes the existing card's buttons instead of posting another card. Distinct native requests and changed proposals remain separate. If the original send has no confirmed receipt, another copy is not sent automatically; answer that request in Codex. Existing cards from an older version lack the required identity, so the first replay after upgrading may create one new card. [Investigation and checks](docs/research/repeated-approval-cards-2026-11-05.md).

Since v0.1.20, long supported approvals arrive as numbered messages (`1/3`, `2/3`, `3/3`) with collapsed review blocks that expand on tap, the same request reference and project/task signature. Large embedded scripts and fenced code examples use short code blocks of at most six lines, including the omission marker, in a single compact approval card; ordinary command arguments remain complete; large quoted context may also be abbreviated, and repeated policy code points to the command preview. Several source examples share a budget; excess examples have an omission notice. Compact code cards keep the normal code formatting and buttons without collapsible quotations. A visible warning states that the button approves the complete original command available in Codex. Proposed file changes and requested permissions remain complete. Decision buttons appear on the final part after every part has a confirmed receipt. Restarting resumes only the remaining confirmed-safe work after Codex revalidates the pending request; an unknown send outcome requires checking Codex. Available in v0.1.20.

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

Since v0.1.17, supported command, file-change and permission approvals from loaded spawned subagents are delivered to the attached root session's topic. Cards identify the agent by name and full ID. Pending requests are recovered by subscribing to each eligible child after reconnect or topic recovery; decisions answer the original child request once. Every ancestor must remain eligible. Child commentary, final answers and questions are not mirrored; direct Telegram instructions still address the interactive root. See [implementation and checks](docs/research/subagent-approvals-2026-11-05.md).

## Updating Codex and recovering its executable

If a Codex update removes the saved executable, restart the relay after starting your normal Codex sessions. The relay searches the supported native installation locations and saves a replacement path only after initialization and a successful shared-daemon session-list check. Pairing, bot token, session/topic IDs and native permissions are preserved. No CLI is downloaded, no alternate daemon is started, and no model turn is used for this check. Compatibility beyond the qualified Codex version still needs acceptance testing.

If discovery fails, select the installed native executable explicitly:

```sh
npm start -- --codex-bin /absolute/path/to/native/codex
```

On Windows use an absolute path to codex.exe. An existing but invalid executable is rejected rather than silently replaced. doctor --codex-bin PATH can inspect a replacement without saving any configuration.

Known unanswered host questions now survive later turns and reconnects. Recovery extends only as far back as those known questions require; unrelated older questions are not imported. Very large questions and capacity limits produce terminal notices. Partial question answers are kept privately for up to seven days and restored only when stable identity and question contents match. A rejected native input remains retryable; accepted or uncertain input is not automatically repeated.
