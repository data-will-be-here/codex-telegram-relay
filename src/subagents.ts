import { allowedSessionDirectory, type Config } from './config.js';
import { object, string, type AgentOrigin, type Binding, type Codex } from './types.js';

/** Resolve only verified spawned descendants of an attached interactive root. */
export async function agentRoute(threadId: string, codex: Codex, config: Config,
  attachedBinding: (id: string) => Binding | undefined): Promise<{ binding: Binding; agent: AgentOrigin } | undefined> {
  const visited = new Set<string>();
  let current = threadId;
  let name = 'Agent';
  for (let depth = 0; depth < 16; depth++) {
    if (!current || visited.has(current) || config.ignoredThreadIds?.includes(current)) return;
    visited.add(current);
    const thread = await codex.read(current, 1000);
    if (thread.id !== current || thread.ephemeral === true || string(object(thread.status).type) === 'notLoaded' ||
        !allowedSessionDirectory(string(thread.cwd), config)) return;
    const binding = attachedBinding(current);
    if (binding) {
      if (current === threadId || binding.cwd !== thread.cwd || !['cli', 'vscode', 'appServer'].includes(string(thread.source)) ||
          thread.parentThreadId || thread.canAcceptDirectInput === false) return;
      return { binding, agent: { threadId, name } };
    }
    const spawn = object(object(object(thread.source).subAgent).thread_spawn);
    const parent = string(thread.parentThreadId);
    if (!parent || spawn.parent_thread_id !== parent || thread.canAcceptDirectInput !== false) return;
    if (depth === 0) name = string(spawn.agent_path) || string(spawn.agent_nickname) || string(thread.name) || name;
    current = parent;
  }
}
