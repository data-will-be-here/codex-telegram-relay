import { codexCandidates, type CodexCandidate, type Config } from './config.js';

export interface ConnectionClient {
  connect(binary: string): Promise<void>;
  probeReadOnly(): Promise<boolean>;
  close(): void;
}

export interface ConnectionOptions<T extends ConnectionClient> {
  createClient: () => T;
  override?: string;
  signal?: AbortSignal;
}

export interface CodexConnection<T extends ConnectionClient> {
  client: T;
  candidate: CodexCandidate;
  config: Config;
  changed: boolean;
  fallback: boolean;
}

/** Select only after native initialization and a read-only shared-daemon probe. */
export async function connectCodex<T extends ConnectionClient>(config: Config, options: ConnectionOptions<T>): Promise<CodexConnection<T>> {
  const candidates = codexCandidates(config, options.override);
  for (const [index, candidate] of candidates.entries()) {
    if (options.signal?.aborted) throw new Error('Codex connection cancelled.');
    const client = options.createClient();
    let closed = false;
    const close = (): void => { if (!closed) { closed = true; client.close(); } };
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const cancel = (): void => { close(); rejectCancelled(new Error('Codex connection cancelled.')); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (options.signal?.aborted) cancel();
      await Promise.race([options.signal?.aborted ? cancelled : client.connect(candidate.binary), cancelled]);
      if (options.signal?.aborted) throw new Error('Codex connection cancelled.');
      if (!await Promise.race([client.probeReadOnly(), cancelled]) || options.signal?.aborted) throw new Error('Codex shared-daemon API check failed.');
      const selected = structuredClone(config);
      selected.codexBinary = candidate.binary;
      if (options.override) selected.codexSelection = { mode: 'fixed' };
      else if (selected.codexSelection?.mode === 'auto' && candidate.source !== 'previous' && candidate.source !== 'fixed') {
        selected.codexSelection = { mode: 'auto', source: candidate.source };
      }
      return { client, candidate, config: selected, changed: JSON.stringify(selected) !== JSON.stringify(config), fallback: index > 0 };
    } catch {
      close();
      if (options.signal?.aborted) throw new Error('Codex connection cancelled.');
    } finally { options.signal?.removeEventListener('abort', cancel); }
  }
  throw new Error('No selected Codex proxy passed the read-only shared-daemon check. Run doctor or select a native executable explicitly.');
}
