import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { allowedSessionDirectory, privateDirectory, privateRead, readConfig } from './config.js';
import { withProjectHeader } from './format.js';
import { TelegramError } from './telegram.js';
import { integer, object, type Binding, type Telegram } from './types.js';

export const MAX_EXPORT_BYTES = 49_000_000;
const CACHE_BYTES = 200_000_000;
const EXPIRES_MS = 10 * 60_000;
const ACTIVE = "('preparing','pending','sending')";
type Status = 'preparing' | 'pending' | 'sending' | 'sent' | 'rejected' | 'uncertain';
type Kind = 'video' | 'document';
interface Job extends Binding {
  id: string; fingerprint: string; ownerId: number; name: string; hash: string; size: number;
  kind: Kind; caption: string; status: Status; at: number; retryAt: number; attempts: number;
  messageId: number | null; error: string | null;
}
export interface FileReceipt {
  id: string; status: Status; name: string; bytes: number; sha256: string; session: string;
  messageId: number | null; error: string | null;
}
export interface FileRequest { path: string; session?: string; as?: 'auto' | Kind; caption?: string; requestId?: string; }

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const receipt = (job: Job): FileReceipt => ({ id: job.id, status: job.status, name: job.name, bytes: job.size, sha256: job.hash, session: job.threadId, messageId: job.messageId, error: job.error });
const inside = (root: string, path: string): boolean => { const diff = relative(root, path); return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith(`..${sep}`)); };

/** Bounded regular-file read from one handle; never follow a link or wait on a pipe. */
function bytesFrom(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > MAX_EXPORT_BYTES) throw new Error('Export requires a nonempty regular file, without links, up to 49,000,000 bytes.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Export file changed while opening.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error('Export file changed while reading.');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) throw new Error('Export file changed while reading.');
    return bytes;
  } finally { closeSync(fd); }
}

function source(path: string, binding: Binding, home: string): { name: string; bytes: Buffer } {
  if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path) || path.startsWith('\\\\') || path.startsWith('//')) throw new Error('Invalid export path.');
  const full = resolve(path);
  if (process.platform === 'win32' && full.slice(2).includes(':')) throw new Error('Windows alternate streams are not supported.');
  const root = realpathSync(binding.cwd);
  if (!inside(root, full) || inside(realpathSync(home), full)) throw new Error('Export file must be inside this session project, outside relay private data.');
  let cursor = root;
  for (const component of relative(root, full).split(sep)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Export paths must not contain links.');
  }
  if (!inside(root, realpathSync(full))) throw new Error('Export path escapes the session project.');
  const name = basename(full);
  if (name.length > 180 || /["\\]/u.test(name)) throw new Error('Export filename is too long or invalid.');
  const bytes = bytesFrom(full);
  if (relative(realpathSync(full), full) !== '') throw new Error('Export path changed while reading.');
  return { name, bytes };
}

/** Shared local queue. Producers use only non-secret preferences; the relay owns uploads. */
export class Files {
  private db: DatabaseSync;
  private generation: string | undefined;
  private ownerId: number | undefined;
  private busy = false;
  constructor(private readonly home: string) {
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      const path = join(home, name);
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Invalid export queue path.');
    }
    if (!existsSync(join(home, 'state.sqlite'))) throw new Error('Start the relay before sending files.');
    this.db = new DatabaseSync(join(home, 'state.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS file_runtime(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,ownerId INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS file_jobs(
        id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,ownerId INTEGER NOT NULL,threadId TEXT NOT NULL,topicId INTEGER NOT NULL,
        cwd TEXT NOT NULL,title TEXT NOT NULL,lastTurn TEXT,name TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,
        kind TEXT NOT NULL,caption TEXT NOT NULL,status TEXT NOT NULL,at INTEGER NOT NULL,retryAt INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,messageId INTEGER,error TEXT);
      CREATE INDEX IF NOT EXISTS file_jobs_pending ON file_jobs(status,retryAt,at);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(file_jobs)').all().some(column => column.name === 'sessionName')) this.db.exec('ALTER TABLE file_jobs ADD COLUMN sessionName TEXT');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Only the singleton relay calls this after acquiring State's process lock. */
  startWorker(ownerId: number): void {
    this.ownerId = ownerId;
    this.generation = privateRead(join(this.home, 'relay.lock'));
    privateDirectory(join(this.home, 'outgoing'));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec("UPDATE file_jobs SET status='uncertain',error='Relay stopped during upload; inspect Telegram before retrying.' WHERE status='sending'; UPDATE file_jobs SET status='rejected',error='Interrupted before queueing.' WHERE status='preparing';");
      this.db.prepare('INSERT OR REPLACE INTO file_runtime VALUES(1,?,?)').run(this.generation, ownerId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.cleanup();
  }
  close(): void {
    if (this.generation) this.db.prepare('DELETE FROM file_runtime WHERE generation=?').run(this.generation);
    this.db.close();
  }
  private ownsScratch(cwd: string, threadId?: string): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='new_sessions'").get()) return false;
    return !!this.db.prepare("SELECT 1 FROM new_sessions WHERE json_extract(payload,'$.cwd')=? AND json_extract(payload,'$.kind')='scratch' AND json_extract(payload,'$.threadId') IS NOT NULL AND status IN ('persisted','topic','ready') " + (threadId ? " AND json_extract(payload,'$.threadId')=?" : '') + ' LIMIT 1').get(cwd, ...(threadId ? [threadId] : []));
  }
  status(id: string): FileReceipt {
    const job = this.job(id);
    if (!job || job.ownerId !== readConfig(this.home).ownerId) throw new Error('Unknown file request.');
    return receipt(job);
  }
  enqueue(request: FileRequest, cwd = process.cwd(), session = process.env.CODEX_THREAD_ID): FileReceipt {
    const config = readConfig(this.home);
    if (config.outgoingFiles !== true) throw new Error('File export is disabled. Enable once locally with: files enable');
    const generation = privateRead(join(this.home, 'relay.lock'));
    const runtime = this.db.prepare('SELECT generation,ownerId FROM file_runtime WHERE id=1').get();
    if (runtime?.generation !== generation || runtime.ownerId !== config.ownerId) throw new Error('Restart the updated relay before sending files.');
    const pid = Number(generation.split(':')[0]);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid relay process lock.');
    try { process.kill(pid, 0); } catch { throw new Error('Relay is not running. Start it before sending files.'); }
    this.cleanup();
    const target = request.session ?? session;
    if (target && !/^[a-zA-Z0-9-]{6,128}$/u.test(target)) throw new Error('Invalid session ID or prefix.');
    let bindings = (this.db.prepare('SELECT * FROM bindings').all() as unknown as Binding[]).filter(binding =>
      !config.ignoredThreadIds?.includes(binding.threadId) && allowedSessionDirectory(binding.cwd, config, this.ownsScratch(binding.cwd, binding.threadId)) &&
      (target ? binding.threadId.startsWith(target) : realpathSync(binding.cwd) === realpathSync(cwd)));
    if (target && bindings.some(binding => binding.threadId === target)) bindings = bindings.filter(binding => binding.threadId === target);
    if (bindings.length !== 1) throw new Error('Select exactly one session with --session ID. No file was queued.');
    const binding = bindings[0]!;
    const { name, bytes } = source(request.path, binding, this.home);
    const as = request.as ?? 'auto';
    if (!['auto', 'video', 'document'].includes(as)) throw new Error('Use --as auto, video or document.');
    const mp4 = name.toLowerCase().endsWith('.mp4') && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
    if (as === 'video' && !mp4) throw new Error('Video uploads require an MP4 file. Use --as document for other formats.');
    const kind = as === 'video' || (as === 'auto' && mp4) ? 'video' : 'document';
    const caption = request.caption ?? '';
    if (caption.length > 800 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(caption)) throw new Error('Caption must be at most 800 characters without control characters.');
    const hash = digest(bytes);
    const fingerprint = digest(JSON.stringify([config.ownerId, binding.threadId, binding.topicId, binding.cwd, name, hash, kind, caption]));
    const id = request.requestId ?? fingerprint;
    if (!/^[a-zA-Z0-9_-]{8,128}$/u.test(id)) throw new Error('Request ID must contain 8-128 letters, digits, underscores or hyphens.');
    const old = this.job(id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('Request ID already belongs to different content.');
      return receipt(old);
    }
    privateDirectory(join(this.home, 'outgoing'));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const concurrent = this.job(id);
      if (concurrent) {
        if (concurrent.fingerprint !== fingerprint) throw new Error('Request ID already belongs to different content.');
        this.db.exec('COMMIT'); return receipt(concurrent);
      }
      this.cleanCache();
      const quota = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM file_jobs WHERE status IN ${ACTIVE}`).get()!;
      if (Number(quota.count) >= 16 || Number(quota.bytes) + bytes.length > CACHE_BYTES) throw new Error('File queue is full. Wait for pending uploads.');
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM file_jobs').get()!.count) >= 10_000) throw new Error('File receipt capacity reached. Inspect the local queue.');
      this.db.prepare(`INSERT INTO file_jobs(id,fingerprint,ownerId,threadId,topicId,cwd,title,lastTurn,name,hash,size,kind,caption,status,at,sessionName) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing',?,?)`)
        .run(id, fingerprint, config.ownerId, binding.threadId, binding.topicId, binding.cwd, binding.title, binding.lastTurn, name, hash, bytes.length, kind, caption, Date.now(), binding.sessionName ?? null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try {
      const fd = openSync(this.snapshot(id), 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      this.db.prepare("UPDATE file_jobs SET status='pending' WHERE id=? AND status='preparing'").run(id);
    } catch {
      this.finish(id, 'rejected', 'Could not create private export snapshot.');
      throw new Error('Could not queue file. Check files status before retrying.');
    }
    return receipt(this.job(id)!);
  }
  /** A separate consumer: awaiting a large upload never occupies the message sender. */
  async flushOne(telegram: Telegram, authorize: (binding: Binding) => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    if (this.busy || signal.aborted) return false;
    if (!this.generation) throw new Error('Only the running relay file worker can upload.');
    this.busy = true;
    try {
      this.cleanup();
      const job = this.db.prepare("SELECT * FROM file_jobs WHERE status='pending' AND retryAt<=? ORDER BY at LIMIT 1").get(Date.now()) as unknown as Job | undefined;
      if (!job) return false;
      let bytes: Buffer;
      try {
        const allowed = (): boolean => {
          const config = readConfig(this.home);
          const binding = this.db.prepare('SELECT * FROM bindings WHERE threadId=?').get(job.threadId);
          return config.outgoingFiles === true && this.ownerId === job.ownerId && config.ownerId === job.ownerId && !config.ignoredThreadIds?.includes(job.threadId) &&
            allowedSessionDirectory(job.cwd, config, this.ownsScratch(job.cwd, job.threadId)) && binding?.topicId === job.topicId && binding.cwd === job.cwd;
        };
        if (!allowed() || !await authorize(job) || !allowed()) { this.finish(job.id, 'rejected', 'Export disabled or session/destination is no longer eligible.'); return true; }
        bytes = bytesFrom(this.snapshot(job.id));
        if (bytes.length !== job.size || digest(bytes) !== job.hash) throw new Error('Private export snapshot changed.');
        // Another process can revoke export while the snapshot is being read/hashed.
        if (!allowed()) { this.finish(job.id, 'rejected', 'Export revoked before uploading.'); return true; }
        if (signal.aborted) return false;
        if (!telegram.upload) throw new Error('This Telegram adapter does not support uploads.');
      } catch {
        this.finish(job.id, 'rejected', 'Export validation failed or session is unavailable. No upload was started.');
        return true;
      }
      const changed = this.db.prepare("UPDATE file_jobs SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'").run(job.id).changes;
      if (!changed) return false;
      const formatted = withProjectHeader({ text: job.caption || job.name, entities: [] }, job.cwd, job.sessionName, this.ownsScratch(job.cwd, job.threadId) ? 'Без проекта' : undefined);
      try {
        const result = object(await telegram.upload!(job.kind === 'video' ? 'sendVideo' : 'sendDocument', {
          chat_id: job.ownerId, message_thread_id: job.topicId, caption: formatted.text, caption_entities: formatted.entities,
        }, { name: job.name, bytes }, signal));
        const messageId = integer(result.message_id);
        if (!messageId || object(result.chat).id !== job.ownerId || result.message_thread_id !== job.topicId) {
          this.finish(job.id, 'uncertain', 'Telegram returned an unexpected destination or no receipt. Inspect Telegram before retrying.');
        } else {
          this.finish(job.id, 'sent', null, messageId);
        }
      } catch (error) {
        if (error instanceof TelegramError && error.status === 429 && job.attempts < 3) {
          this.db.prepare("UPDATE file_jobs SET status='pending',retryAt=? WHERE id=?").run(Date.now() + Math.max(1, Math.min(error.retryAfter ?? 5, 3600)) * 1000, job.id);
        } else if (error instanceof TelegramError && [400, 403, 413, 429].includes(error.status)) {
          this.finish(job.id, 'rejected', `Telegram rejected upload (${error.status}). No automatic retry.`);
        } else this.finish(job.id, 'uncertain', 'Upload outcome is unknown. Inspect Telegram before retrying; automatic replay is disabled.');
      }
      return true;
    } finally { this.busy = false; }
  }
  private job(id: string): Job | undefined { return this.db.prepare('SELECT * FROM file_jobs WHERE id=?').get(id) as unknown as Job | undefined; }
  private snapshot(id: string): string { return join(this.home, 'outgoing', `${digest(id)}.bin`); }
  private finish(id: string, status: 'sent' | 'rejected' | 'uncertain', error: string | null, messageId: number | null = null): void {
    // Do not free admission quota before terminal snapshot deletion has been attempted.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE file_jobs SET status=?,error=?,messageId=? WHERE id=?').run(status, error, messageId, id);
      this.removeSnapshot(id);
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }
  private removeSnapshot(id: string): void { try { unlinkSync(this.snapshot(id)); } catch { /* Bounded orphan cleanup retries later. */ } }
  private cleanup(): void {
    // Serialize the live inventory and orphan deletion with every producer reservation.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE file_jobs SET status='rejected',error='Export expired before sending.' WHERE status IN ('preparing','pending') AND at<?`).run(Date.now() - EXPIRES_MS);
      this.cleanCache();
      // Keep ambiguous receipts until the owner has inspected them; successful receipts deduplicate for seven days.
      this.db.prepare("DELETE FROM file_jobs WHERE status IN ('sent','rejected') AND at<?").run(Date.now() - 7 * 86400_000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Caller holds BEGIN IMMEDIATE, including admission's final quota check. */
  private cleanCache(): void {
    const live = new Set(this.db.prepare(`SELECT id FROM file_jobs WHERE status IN ${ACTIVE}`).all().map(row => basename(this.snapshot(String(row.id)))));
    const cache = join(this.home, 'outgoing');
    if (!existsSync(cache)) return;
    privateDirectory(cache);
    for (const name of readdirSync(cache)) if (/^[a-f0-9]{64}\.bin$/u.test(name) && !live.has(name)) {
      // Fail closed if orphan bytes cannot be removed: the disk quota must include failed cleanup.
      try { unlinkSync(join(cache, name)); } catch (error) { if (object(error).code !== 'ENOENT') throw error; }
    }
  }
}
