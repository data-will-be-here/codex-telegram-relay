import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './config.js';
import { object, string, type Binding, type Json, type MessageMode, type TopicTitleMode } from './types.js';

export interface Delivery { id: number; key: string; topicId: number | null; text: string; markup: Json | null; projectCwd: string | null; }
export interface TopicOperation {
  threadId: string; cwd: string; title: string; attempt: string;
  status: 'missing' | 'creating' | 'uncertain' | 'failed' | 'retry'; retryAt: number;
}

export class State {
  private db: DatabaseSync;
  private lock: string;
  private lockValue: string;
  constructor(home: string) {
    privateDirectory(home);
    this.lock = join(home, 'relay.lock');
    this.lockValue = `${process.pid}:${randomUUID()}`;
    if (existsSync(this.lock)) {
      if (!lstatSync(this.lock).isFile() || lstatSync(this.lock).isSymbolicLink()) throw new Error('Invalid relay lock.');
      const old = readFileSync(this.lock, 'utf8');
      const pid = Number(old.split(':')[0]);
      let alive = true;
      try { if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0); else throw new Error('Invalid lock PID.'); }
      catch (error) { if (object(error).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Another relay may already be running. Stop it before starting a second consumer.');
      if (readFileSync(this.lock, 'utf8') !== old) throw new Error('Relay lock changed; try again.');
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, 'wx', 0o600);
    writeFileSync(fd, this.lockValue); closeSync(fd);
    try {
      const path = join(home, 'state.sqlite');
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Invalid state database path.');
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS bindings(threadId TEXT PRIMARY KEY, topicId INTEGER NOT NULL UNIQUE, cwd TEXT NOT NULL, title TEXT NOT NULL, lastTurn TEXT);
        CREATE TABLE IF NOT EXISTS incoming(id INTEGER PRIMARY KEY, topicId INTEGER, status TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, topicId INTEGER, text TEXT NOT NULL, markup TEXT, status TEXT NOT NULL DEFAULT 'pending', messageId INTEGER, at INTEGER NOT NULL, projectCwd TEXT);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS replies(threadId TEXT PRIMARY KEY, inputId INTEGER NOT NULL, turnId TEXT);
        CREATE TABLE IF NOT EXISTS topic_operations(threadId TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, attempt TEXT NOT NULL, status TEXT NOT NULL, retryAt INTEGER NOT NULL DEFAULT 0);
        UPDATE topic_operations SET status='uncertain' WHERE status='creating';
        UPDATE incoming SET status='uncertain' WHERE status='dispatching';
        UPDATE outbox SET status='uncertain' WHERE status='sending';
        UPDATE outbox SET status='cancelled' WHERE status='pending' AND key LIKE 'prompt/%';`);
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'projectCwd')) this.db.exec('ALTER TABLE outbox ADD COLUMN projectCwd TEXT');
      this.prune();
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  close(): void {
    this.db.close();
    if (existsSync(this.lock) && readFileSync(this.lock, 'utf8') === this.lockValue) unlinkSync(this.lock);
  }
  bindings(): Binding[] { return this.db.prepare('SELECT * FROM bindings').all() as unknown as Binding[]; }
  binding(threadId: string): Binding | undefined { return this.db.prepare('SELECT * FROM bindings WHERE threadId=?').get(threadId) as unknown as Binding | undefined; }
  topic(topicId: number): Binding | undefined { return this.db.prepare('SELECT * FROM bindings WHERE topicId=?').get(topicId) as unknown as Binding | undefined; }
  bind(threadId: string, topicId: number, cwd: string, title: string): void {
    this.db.prepare('INSERT INTO bindings(threadId,topicId,cwd,title) VALUES(?,?,?,?)').run(threadId, topicId, cwd, title);
  }
  topicOperations(): TopicOperation[] { return this.db.prepare('SELECT * FROM topic_operations').all() as unknown as TopicOperation[]; }
  topicOperation(threadId: string): TopicOperation | undefined { return this.db.prepare('SELECT * FROM topic_operations WHERE threadId=?').get(threadId) as unknown as TopicOperation | undefined; }
  beginTopic(threadId: string, cwd: string, title: string): TopicOperation | undefined {
    const previous = this.topicOperation(threadId);
    if (previous && (['creating', 'uncertain', 'failed'].includes(previous.status) || previous.retryAt > Date.now())) return undefined;
    this.db.prepare("INSERT INTO topic_operations VALUES(?,?,?,?,'creating',0) ON CONFLICT(threadId) DO UPDATE SET cwd=excluded.cwd,title=excluded.title,attempt=excluded.attempt,status='creating',retryAt=0").run(threadId, cwd, title, randomUUID());
    return this.topicOperation(threadId);
  }
  topicResult(threadId: string, attempt: string, status: TopicOperation['status'], retryAt = 0): void {
    this.db.prepare('UPDATE topic_operations SET status=?,retryAt=? WHERE threadId=? AND attempt=?').run(status, retryAt, threadId, attempt);
  }
  retryTopic(threadId: string): void {
    this.db.prepare("UPDATE topic_operations SET status='missing',retryAt=0 WHERE threadId=? AND status!='creating'").run(threadId);
  }
  missingTopic(binding: Binding): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT OR IGNORE INTO topic_operations VALUES(?,?,?,?,'missing',0)").run(binding.threadId, binding.cwd, binding.title, randomUUID());
      this.db.prepare("UPDATE outbox SET status=CASE WHEN key LIKE 'prompt/%' THEN 'cancelled' ELSE 'blocked' END WHERE topicId=? AND status IN ('pending','sending')").run(binding.topicId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  installTopic(threadId: string, topicId: number, cwd: string, title: string): Binding {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.binding(threadId);
      this.db.prepare('INSERT INTO bindings(threadId,topicId,cwd,title) VALUES(?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET topicId=excluded.topicId,cwd=excluded.cwd,title=excluded.title').run(threadId, topicId, cwd, title);
      if (previous && previous.topicId !== topicId) {
        this.db.prepare("UPDATE outbox SET status='cancelled' WHERE topicId=? AND key LIKE 'prompt/%' AND status IN ('pending','blocked')").run(previous.topicId);
        this.db.prepare("UPDATE outbox SET topicId=?,status='pending' WHERE topicId=? AND status IN ('pending','blocked')").run(topicId, previous.topicId);
      }
      this.db.prepare('DELETE FROM topic_operations WHERE threadId=?').run(threadId);
      this.db.exec('COMMIT');
      return this.binding(threadId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  baseline(threadId: string, turnId: string): void { this.db.prepare('UPDATE bindings SET lastTurn=? WHERE threadId=?').run(turnId, threadId); }
  topicTitleMode(): TopicTitleMode { return this.db.prepare("SELECT value FROM settings WHERE key='topicTitleMode'").get()?.value === 'status' ? 'status' : 'simple'; }
  setTopicTitleMode(mode: TopicTitleMode): void {
    if (mode !== 'status' && mode !== 'simple') throw new Error('Invalid topic title mode.');
    this.db.prepare("INSERT INTO settings VALUES('topicTitleMode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
  }
  topicTitleRetryAt(threadId: string): number {
    return Math.max(Number(this.db.prepare('SELECT value FROM settings WHERE key=?').get('titleRetry/' + threadId)?.value ?? 0),
      Number(this.db.prepare("SELECT value FROM settings WHERE key='titleRetry/all'").get()?.value ?? 0));
  }
  deferTopicTitle(threadId: string, until: number): void {
    this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('titleRetry/' + threadId, String(until));
  }
  confirmTopicTitle(threadId: string, title: string): void {
    this.db.prepare('UPDATE bindings SET title=? WHERE threadId=?').run(title, threadId);
    this.db.prepare('DELETE FROM settings WHERE key=?').run('titleRetry/' + threadId);
  }
  sessionDirectory(threadId: string, cwd: string): void { this.db.prepare('UPDATE bindings SET cwd=? WHERE threadId=? AND cwd!=?').run(cwd, threadId, cwd); }
  messageMode(): MessageMode { return this.db.prepare("SELECT value FROM settings WHERE key='messageMode'").get()?.value === 'compact' ? 'compact' : 'all'; }
  setMessageMode(mode: MessageMode): void {
    if (mode !== 'all' && mode !== 'compact') throw new Error('Invalid message mode.');
    this.db.prepare("INSERT INTO settings VALUES('messageMode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
  }
  offset(): number | undefined {
    const value = this.db.prepare("SELECT value FROM settings WHERE key='offset'").get()?.value;
    return value === undefined ? undefined : Number(value);
  }
  admit(id: number, topicId: number | null): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO incoming VALUES(?,?,'dispatching',?)").run(id, topicId, Date.now());
    return Number(result.changes) > 0;
  }
  finish(id: number, status: 'done' | 'uncertain' | 'rejected'): void { this.db.prepare('UPDATE incoming SET status=? WHERE id=?').run(status, id); }
  advance(id: number): void {
    this.db.prepare("INSERT INTO settings VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<CAST(excluded.value AS INTEGER)").run(String(id + 1));
  }
  awaitReply(threadId: string, inputId: number, turnId: string | null): void {
    this.db.prepare('INSERT INTO replies VALUES(?,?,?) ON CONFLICT(threadId) DO UPDATE SET inputId=excluded.inputId,turnId=excluded.turnId').run(threadId, inputId, turnId);
  }
  reply(threadId: string): { inputId: number; turnId: string | null } | undefined {
    return this.db.prepare('SELECT inputId,turnId FROM replies WHERE threadId=?').get(threadId) as { inputId: number; turnId: string | null } | undefined;
  }
  replyTurn(threadId: string, inputId: number, turnId: string): void {
    this.db.prepare('UPDATE replies SET turnId=? WHERE threadId=? AND inputId=?').run(turnId, threadId, inputId);
  }
  clearReply(threadId: string, inputId: number): void { this.db.prepare('DELETE FROM replies WHERE threadId=? AND inputId=?').run(threadId, inputId); }
  enqueue(key: string, topicId: number | null, text: string, markup: Json | null = null, projectCwd?: string): void {
    if (text.length > 40_000) text = text.slice(0, 39_900) + '\n[Message shortened. See the terminal for the full answer.]';
    if (Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','blocked')").get()?.n ?? 0) >= 1000) throw new Error('Delivery queue is full; check Telegram connectivity.');
    const binding = topicId === null ? undefined : this.topic(topicId);
    const blocked = binding && this.topicOperation(binding.threadId);
    const status = blocked ? key.startsWith('prompt/') ? 'cancelled' : 'blocked' : 'pending';
    this.db.prepare('INSERT OR IGNORE INTO outbox(key,topicId,text,markup,at,status,projectCwd) VALUES(?,?,?,?,?,?,?)').run(key, topicId, text, markup === null ? null : JSON.stringify(markup), Date.now(), status, projectCwd ?? binding?.cwd ?? null);
  }
  next(): Delivery | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get();
    if (!row) return undefined;
    return { id: Number(row.id), key: string(row.key), topicId: row.topicId === null ? null : Number(row.topicId), text: string(row.text), markup: row.markup === null ? null : object(JSON.parse(string(row.markup))), projectCwd: typeof row.projectCwd === 'string' ? row.projectCwd : null };
  }
  sending(id: number): void { this.db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(id); }
  delivered(id: number, messageId: number | null): void { this.db.prepare("UPDATE outbox SET status='sent',messageId=? WHERE id=?").run(messageId, id); }
  uncertain(id: number): void { this.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(id); }
  cancelDelivery(id: number): void { this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=? AND status='pending'").run(id); }
  cancelPrompt(key: string): number | undefined {
    const id = this.db.prepare('SELECT messageId FROM outbox WHERE key=?').get(key)?.messageId;
    this.db.prepare("UPDATE outbox SET status='cancelled' WHERE key=? AND status='pending'").run(key);
    return typeof id === 'number' ? id : undefined;
  }
  uncertainCount(): number { return Number(this.db.prepare("SELECT (SELECT count(*) FROM incoming WHERE status='uncertain')+(SELECT count(*) FROM outbox WHERE status='uncertain') AS n").get()?.n ?? 0); }
  prune(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM incoming WHERE at<? AND status IN ('done','rejected')").run(cutoff);
    this.db.prepare("DELETE FROM outbox WHERE at<? AND status IN ('sent','cancelled')").run(cutoff);
  }
}
