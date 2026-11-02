# Codex Telegram Relay

A local companion for your existing Codex sessions. Each session gets its own topic in a private chat with **your own Telegram bot**. Receive questions, approval requests and completed answers; reply from Telegram to the same native session.

[Русский README](README.ru.md)

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
- Session discovery includes native terminal and IDE sessions, excluding subagents and ephemeral contexts.
- Topics use the project plus a short session ID. Session routing uses saved IDs, independently of display names.
- Every message part starts with an italic `» project-name` signature, including project notices outside topics. General relay notices use `» codex-telegram-relay`.
- By default, all assistant messages are delivered. Command output, file/tool events and internal reasoning items are excluded.
- Replies immediately steer a running turn or start the next turn when idle.
- `/mode all` delivers all assistant commentary and final answers; `/mode compact` delivers the first reply to Telegram input and final answer. This owner-only preference applies to all sessions, persists and changes immediately for future messages.
- Assistant messages render Markdown emphasis, links and code; long answers preserve formatting across messages. Local file and preview links show their targets as text. A definite Telegram entity rejection falls back to plain text without repeating accepted parts.
- Structured native questions show numbered choices, descriptions and inline answer buttons. You can also type an answer. Questions written only in ordinary assistant prose are delivered as text, without inferred buttons.
- Native sandbox, network, model, approval and instruction settings are inherited, not replaced.
- Runtime npm dependencies are `ws` (native transport) and `marked` (Markdown parsing). SQLite comes with Node.

This is an initial developer release. Native transport, completion, questions, live steering and cross-client approval cancellation were qualified on Windows with CLI **0.166.0**, using a Telegram simulator. A real paired bot was subsequently checked for topic creation, bidirectional messages, formatting and native question responses. Sleep/reconnect, other native client versions and clean-machine installation still need acceptance checks. [Verification](docs/verification.md), [compatibility and limitations](docs/architecture.md).

## Requirements

- Node.js **22.13 or newer**; Node 24 LTS is recommended. Node 22 prints an experimental SQLite warning.
- A current, authenticated Codex CLI exposing `codex app-server proxy`, with a normal session already running. Send its first prompt before setup: an empty window has no resumable history yet.
- A dedicated bot created through [@BotFather](https://t.me/BotFather), with **private-chat topics enabled**.
- Your computer stays on and connected to the internet while you use the relay.

The repository is currently private; installation requires repository access. No npm registry publication is configured.

## Install and pair

```sh
git clone https://github.com/data-will-be-here/codex-telegram-relay.git
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

### Windows

The relay launches a **native `codex.exe`**, never a `.cmd`/`.bat` shell wrapper. It searches the npm Codex installation and the managed daemon package. If needed, pass the native executable explicitly:

```powershell
npm start -- doctor --codex-bin 'C:\absolute\path\to\codex.exe'
npm start -- setup --codex-bin 'C:\absolute\path\to\codex.exe'
```

### macOS and Linux

Executable links from Homebrew/native installers are resolved. For npm installations, the relay locates the actual platform binary behind `codex.js`, including hoisted and nested optional packages; the JavaScript/shell launcher is never executed by the relay. Unix execute permissions and ELF/Mach-O format are checked. CI installs official Codex 0.166.0 and checks its native version and proxy command on each OS; a complete real-session/Telegram exchange on macOS/Linux still needs acceptance testing.

### Add another project

```sh
npm start -- projects add /absolute/path/to/project
```

Restart the relay afterwards. Project paths are resolved before containment checks, so a neighbouring directory with a similar name is not implicitly allowed.

## Telegram controls

| Input | Behaviour |
| --- | --- |
| Text in a project topic | Answer its pending question; otherwise steer the running turn or start a turn in the idle session |
| `/say TEXT` | Send an instruction even while a native question is pending |
| `/sessions` | Show the saved session/topic bindings |
| `/status` | Show connection and uncertain-delivery counts |
| `/mode`, `/mode all`, `/mode compact` | Show or change the assistant-message detail for all sessions; no restart required |
| `/bind SESSION_ID` | Bind an already created topic after uncertain creation; send inside that topic |
| `/repair SESSION_ID` | Explicitly retry a failed/uncertain topic creation after checking whether a topic appeared |
| `/questions` | Redisplay pending native questions |
| `/help` | Show help |
| Approval buttons | Allow **once** or decline the specific pending native request |

The relay accepts only the paired owner in their private chat. It does not expose shell commands, filesystem uploads, `/sandbox`, `/approval`, `/login`, new-session creation or history imports through Telegram.

## State and recovery

Configuration and state live outside your projects:

- Windows: `%LOCALAPPDATA%\codex-telegram-relay`
- Linux/macOS: `$XDG_CONFIG_HOME/codex-telegram-relay`, or `~/.config/codex-telegram-relay`

`config.json` stores the owner, project roots and native executable path. `bot.token` contains the token. `state.sqlite` stores topic bindings, delivery text and delivery status. Treat the entire directory as private. Setup restricts POSIX modes or the Windows directory ACL.

The optional `CODEX_TELEGRAM_RELAY_HOME` environment variable changes this directory, for example for an isolated installation. No other environment variables are required.

A singleton lock prevents two relay instances using the same state directory. A Telegram polling conflict stops the relay rather than replacing another consumer. An existing webhook is never deleted automatically.

One temporarily unavailable Codex session does not stop discovery or relaying for healthy sessions. Transport failures still reconnect.

Topic creation is journaled before calling Telegram. If the response is lost, creation pauses to avoid duplicate topics, including after restarting the relay. The bot sends recovery instructions: use `/bind SESSION_ID` inside the topic if it appeared, or `/repair SESSION_ID` to explicitly retry if it did not. These commands require the paired owner and never submit an instruction to Codex.

If Telegram explicitly reports that a saved topic no longer exists, the relay recreates it for the loaded session and transfers queued undelivered answers. Existing sent history is not imported, and stale approval buttons are cancelled; pending native prompts are reattached with fresh controls. If you want to permanently remove a session's topic, ignore the session locally before deleting the topic.

Duplicate incoming updates do not execute twice. Writes with an ambiguous result are **not** automatically retried. Check the Codex terminal before repeating an instruction after an uncertainty notice. On reconnection, the relay catches up recent completions for saved bindings; it does not dump old history on the first attachment. See [delivery guarantees](docs/architecture.md).

## Development

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

Native questions and supported approvals have buttons and text answers. Host request_user_input_async questions are read from a bounded tail of the selected session journal because Codex 0.166.0 omits them from App Server items. Their answers are delivered as ordinary user input to the matching session; the host UI form may remain open. Journal recovery is limited to the latest turn, seven days and an 8 MiB tail; it is not a full-history guarantee. Sensitive/unsupported questions produce a terminal-required notice instead of forwarding private contents. A disconnected or stopped relay cannot send notices.
