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
- Topics default to the project plus a short session ID. `/topics status` switches to compact project/status names; `/topics simple` restores project/ID names. Session routing always uses saved IDs, even if visible names are identical.
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

Topic names are optional display settings: `/topics status` shows compact names such as `tgmcp · работа` (working), `tgmcp · ждёт` (waiting for input/approval), or `tgmcp · готово` (idle). `/topics simple` keeps the original `project · ID` format and is the default. The setting persists and applies on the next metadata sync, without restarting. Topic IDs and history stay unchanged across renaming/restarts; keep the private state directory when moving installations. Two sessions may share the same visible name and still route correctly by saved IDs.

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
| `/topics`, `/topics status`, `/topics simple` | Show or change topic names globally: project/status or the original project/ID format |
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
