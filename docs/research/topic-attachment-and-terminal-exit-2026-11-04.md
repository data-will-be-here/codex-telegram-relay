# Saved topic attachment and terminal exit

Date: 2026-11-04. Installed native version inspected: Codex CLI 0.166.0.

## Findings

The reported `/repair` → "healthy topic", `/bind` → "healthy topic", ordinary message → "Use an attached project topic" sequence is reproducible without Telegram access. A persisted binding survives native unloading, while Bridge removes the thread from its in-memory attached set. Previously, recovery inferred health solely from the absence of a `topic_operations` row. Ordinary input instead required membership in the attached set. These two conditions can legitimately differ; the recovery response incorrectly presented them as equivalent.

A read-only inspection of the installation confirmed that the messages around 04:59 Moscow time were received in the same topic as the saved binding. The thread was not ignored and its directory was in scope. At investigation time, `thread/loaded/list` excluded that thread and `thread/read` returned `status.type: notLoaded`, with `source: vscode`. No pending topic operation existed. This confirms the current unload state and the misleading recovery diagnosis. The available records do not establish why or exactly when Codex unloaded the conversation. Closing/switching the IDE conversation or restarting its runtime are possibilities, not verified causes. Session IDs, chat IDs, local paths and conversation content are omitted here.

## Reproduction and correction

`npm run build` followed by `node --test dist/test/topic-recovery.test.js` exercises the actual Bridge update handlers with temporary SQLite state and synthetic native/Telegram adapters.

Before the correction, both initial tests failed: unloaded sessions received "healthy topic", and `/bind` in the saved topic could not reconnect a session after a transient attachment failure. The corrected implementation:

- Treats saved routing and native attachment separately, including in `/sessions`.
- Retries normal discovery when `/bind` or `/repair` is sent inside the saved topic with no creation operation pending.
- Explains unloaded/ineligible sessions, attachment failures and unavailable connection checks.
- Identifies the saved topic when invoked from another topic without moving its binding.
- Keeps explicit creation recovery, owner checks, project scope and no-replay guarantees.

Recovery does not resume an unloaded conversation by itself. Resume the exact saved conversation in the native client; a new conversation has a different thread ID and therefore a different topic.

## Can `/exit` close the actual terminal?

The current relay has no `/exit` handler. Slash commands are parsed by the relay; forwarding `/exit` through `turn/start` would submit model input rather than execute a native terminal command.

Official documentation describes [`/exit` and `/quit`](https://learn.chatgpt.com/docs/developer-commands#exit-the-cli-with-quit-or-exit) as commands entered in the interactive CLI. The [App Server protocol](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread) provides `thread/unsubscribe`, which removes only the calling connection's subscription. It does not close another client's CLI/IDE window. `thread/archive` moves persisted conversation history and can affect descendants; it is not a terminal-close operation. `thread/backgroundTerminals/terminate` targets commands launched by the agent, not the interactive Codex client.

This was also checked against bindings generated directly from the installed 0.166.0 executable:

```text
codex app-server generate-ts --experimental --out .local/native-schema
```

The generated `ClientRequest` union contains no per-thread interactive-client exit method. The relay owns only its proxy subprocess, not the already-open native clients. A thread ID is not an operating-system PID or a terminal-tab ID; the inspected conversation originated from VS Code. Killing the daemon or guessing a `codex.exe` process could affect other sessions and would not implement the requested isolation.

## Feasible extension

The requested routing is straightforward: `/exit` selects the current topic's binding; `/exit ID` selects an exact ID or a unique saved prefix, with the same owner and scope checks as recovery. The missing capability is reliable ownership of the target client.

A separately designed launcher or native-client adapter could register the exact thread, client process identity/start time and a private close capability. The relay could then request graceful exit of that registered client, verify the result and refuse ambiguous or unregistered targets. The design must account for clients switching conversations, multiple clients opening one thread, process-ID reuse and uncertain acknowledgements. Closing Codex returns to the parent shell; closing an entire terminal tab/window is a separate capability requiring ownership of that container. VS Code conversations require an IDE-specific adapter.

Recommendation: keep attachment recovery separate and design this explicit client adapter before advertising terminal `/exit`. No substitute that merely unsubscribes, archives history or hides a Telegram topic was implemented. No real terminal or native conversation was closed during this investigation.

## Validation

- Initial red reproduction: 2 failing Bridge regression tests.
- Corrected full suite: 166 passed, 2 platform-specific skips, 0 failures (168 tests total).
- `npm run typecheck`: passed.
- Native investigation: metadata/history-summary reads and schema generation only; no model turns or terminal shutdowns.
- A live Telegram acceptance pass requires restarting the running relay with the updated code. Building does not replace modules already loaded in its process.
