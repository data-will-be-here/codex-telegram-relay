import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Readable, type Writable } from 'node:stream';
import { State } from './state.js';
import { checkForUpdates } from './updates.js';
import { installRelease, updateSupport, UpdateError, type UpdateRunner } from './self-update.js';
import { object, string } from './types.js';

/** Undefined means input ended or startup was cancelled; never implicit consent. */
export function askToUpdate(input: Readable, output: Writable, signal: AbortSignal): Promise<boolean | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const terminal = createInterface({ input, output }); let finished = false;
    const finish = (answer?: boolean): void => {
      if (finished) return; finished = true;
      signal.removeEventListener('abort', cancel); terminal.close(); resolve(answer);
    };
    const cancel = (): void => finish();
    terminal.on('close', cancel); terminal.on('SIGINT', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    terminal.on('line', line => {
      const answer = line.trim().toLowerCase();
      if (['', 'y', 'yes'].includes(answer)) finish(true);
      else if (['n', 'no'].includes(answer)) finish(false);
      else output.write('Please enter Y or N. Update now? [Y/n] ');
    });
    output.write('Update now? [Y/n] ');
  });
}

/** The replacement gets a fresh module graph and owns the relay lock after the parent releases it. */
export async function runUpdatedRelay(root: string, args: string[]): Promise<void> {
  console.log('Starting the updated relay...');
  const forwarded = args[0] === 'start' ? args.slice(1) : args;
  const child = spawn(process.execPath, [join(root, 'dist', 'src', 'cli.js'), 'start', ...forwarded, '--no-update-check'], {
    cwd: root, stdio: 'inherit', shell: false, windowsHide: false,
  });
  // Console Ctrl+C reaches both processes. Let the child shut down gracefully instead of forwarding it twice.
  const interrupt = (): void => {};
  const terminate = (): void => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error('The updated relay could not be started. Run npm start again.')));
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

/** Called only for an interactive startup, before any Telegram polling or native attachment. */
export async function consoleUpdate(root: string, home: string, args: string[], options: {
  run?: UpdateRunner; ask?: () => Promise<boolean | undefined>; restart?: typeof runUpdatedRelay;
} = {}): Promise<boolean> {
  const state = new State(home); const stop = new AbortController();
  const cancel = (): void => stop.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let installed = false;
  try {
    const current = string(object(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).version);
    const release = await checkForUpdates(state, current, { signal: stop.signal, notify: false });
    if (stop.signal.aborted) { process.exitCode = 130; return true; }
    if (!release) return false;
    try { await updateSupport(root, home, options.run, stop.signal); }
    catch (error) {
      if (error instanceof UpdateError && !error.recoverable) throw error;
      if (stop.signal.aborted) { process.exitCode = 130; return true; }
      console.error(error instanceof UpdateError ? error.message : 'Automatic update is unavailable for this installation. Follow the manual upgrade instructions.');
      return false;
    }
    const answer = await (options.ask ? options.ask() : askToUpdate(process.stdin, process.stdout, stop.signal));
    if (answer === undefined) { console.log('\nStartup cancelled.'); process.exitCode = 130; return true; }
    if (!answer) { console.log('Update skipped. Starting the installed relay.'); return false; }
    try {
      await installRelease(root, home, release, { ...(options.run ? { run: options.run } : {}), signal: stop.signal, beforeActivation: () => state.close({ retainLock: true }) });
      installed = true;
      if (stop.signal.aborted) { console.log('Update completed. Startup cancelled. Run npm start when ready.'); process.exitCode = 130; return true; }
    } catch (error) {
      if (error instanceof UpdateError && !error.recoverable) throw error;
      console.error(error instanceof UpdateError ? error.message : 'Update failed; the current installation was kept.');
      if (stop.signal.aborted) { process.exitCode = 130; return true; }
      console.log('Starting the installed relay.');
    }
  } finally {
    state.close(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  if (!installed) return false;
  await (options.restart ?? runUpdatedRelay)(root, args);
  return true;
}
