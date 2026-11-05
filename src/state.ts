import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './config.js';
import { object, string, type Binding, type Json, type MessageMode } from './types.js';

const MAX_ACTIVE_DELIVERIES = 1000;
const OWNER_NOTICE_SQL = "(projectCwd IS NULL AND sourceThreadId IS NULL AND (key LIKE 'notice/%' OR key LIKE 'attention/status/%'))";

export interface RichDeliveryPart { method: 'sendRichMessage' | 'sendMessage'; params: Json; fallback?: string; }
export interface Delivery {
  id: number; key: string; topicId: number | null; text: string; markup: Json | null; projectCwd: string | null;
  sourceThreadId: string | null;
  ownerNotice: boolean;
  richPlan: RichDeliveryPart[] | null; nextPart: number; messageId: number | null;
}
export interface DeliveryContext { topicId: number | null; projectCwd: string | null; sourceThreadId: string | null; ownerNotice: boolean; }
export interface TopicOperation {
  threadId: string; cwd: string; title: string; attempt: string;
  status: 'missing' | 'creating' | 'uncertain' | 'failed' | 'retry'; retryAt: number;
}
export interface ApprovalCard { identity: string; deliveryKey: string; status: string; }

export class State {
  private db: DatabaseSync;
  private lock: string;
  private lockValue: string;
  constructor(readonly home: string) {
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
        CREATE TABLE IF NOT EXISTS async_answers(threadId TEXT NOT NULL, callId TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(threadId,callId));
        CREATE TABLE IF NOT EXISTS host_watch(threadId TEXT PRIMARY KEY, sinceMs INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS question_progress(key TEXT PRIMARY KEY,signature TEXT NOT NULL,answers TEXT NOT NULL,at INTEGER NOT NULL);
        DELETE FROM settings WHERE key='topicTitleMode';
        CREATE TABLE IF NOT EXISTS replies(threadId TEXT PRIMARY KEY, inputId INTEGER NOT NULL, turnId TEXT);
        CREATE TABLE IF NOT EXISTS approval_requests(identity TEXT PRIMARY KEY, threadId TEXT NOT NULL, turnId TEXT NOT NULL, requestId TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS approval_cards(identity TEXT PRIMARY KEY, deliveryKey TEXT NOT NULL UNIQUE, requestIdentity TEXT NOT NULL, ownerToken TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS topic_operations(threadId TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, attempt TEXT NOT NULL, status TEXT NOT NULL, retryAt INTEGER NOT NULL DEFAULT 0);
        UPDATE topic_operations SET status='uncertain' WHERE status='creating';
        UPDATE incoming SET status='uncertain' WHERE status='dispatching';
        UPDATE outbox SET status='uncertain' WHERE status='sending';
        UPDATE outbox SET status='held' WHERE status='pending' AND key IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending');
        UPDATE outbox SET status='cancelled' WHERE status='pending' AND key LIKE 'prompt/%';`);
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'projectCwd')) this.db.exec('ALTER TABLE outbox ADD COLUMN projectCwd TEXT');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'richPlan')) this.db.exec('ALTER TABLE outbox ADD COLUMN richPlan TEXT');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'nextPart')) this.db.exec('ALTER TABLE outbox ADD COLUMN nextPart INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'sourceThreadId')) {
        this.db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE outbox ADD COLUMN sourceThreadId TEXT;
          UPDATE outbox SET sourceThreadId=(SELECT threadId FROM bindings WHERE bindings.topicId=outbox.topicId) WHERE topicId IS NOT NULL;
          UPDATE outbox SET sourceThreadId=(SELECT threadId FROM topic_operations WHERE outbox.key='topic-problem/'||attempt) WHERE key LIKE 'topic-problem/%';
          UPDATE outbox SET sourceThreadId=(SELECT threadId FROM bindings WHERE substr(outbox.key,-length(threadId)-1)='/'||threadId LIMIT 1) WHERE key LIKE 'session-unavailable/%';
          UPDATE outbox SET status='cancelled' WHERE sourceThreadId IS NULL AND (key LIKE 'topic-problem/%' OR key LIKE 'session-unavailable/%') AND status IN ('pending','blocked','deferred');
          COMMIT;`);
      }
      if (!this.db.prepare('PRAGMA table_info(async_answers)').all().some(column => column.name === 'status')) this.db.exec("ALTER TABLE async_answers ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'");
      this.db.exec("UPDATE async_answers SET status='uncertain' WHERE status='sending'; CREATE INDEX IF NOT EXISTS outbox_status_id ON outbox(status,id)");
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
      this.db.prepare("UPDATE outbox SET status=CASE WHEN key LIKE 'prompt/%' THEN 'cancelled' ELSE 'blocked' END WHERE topicId=? AND status IN ('pending','deferred','sending')").run(binding.topicId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  installTopic(threadId: string, topicId: number, cwd: string, title: string): Binding {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.binding(threadId);
      this.db.prepare('INSERT INTO bindings(threadId,topicId,cwd,title) VALUES(?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET topicId=excluded.topicId,cwd=excluded.cwd,title=excluded.title').run(threadId, topicId, cwd, title);
      if (previous && previous.topicId !== topicId) {
        this.db.prepare("UPDATE outbox SET status='cancelled' WHERE topicId=? AND key LIKE 'prompt/%' AND status IN ('pending','blocked','held')").run(previous.topicId);
        this.db.prepare("UPDATE outbox SET topicId=?,status=CASE WHEN key LIKE 'final/%' THEN 'deferred' ELSE 'pending' END WHERE topicId=? AND status IN ('pending','blocked','deferred')").run(topicId, previous.topicId);
      }
      this.db.prepare('DELETE FROM topic_operations WHERE threadId=?').run(threadId);
      this.db.exec('COMMIT');
      return this.binding(threadId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  baseline(threadId: string, turnId: string): void { this.db.prepare('UPDATE bindings SET lastTurn=? WHERE threadId=?').run(turnId, threadId); }
  asyncAnswered(threadId: string, callId: string): boolean { return !!this.db.prepare('SELECT 1 FROM async_answers WHERE threadId=? AND callId=?').get(threadId, callId); }
  asyncAnswerIds(threadId: string): string[] { return this.db.prepare('SELECT callId FROM async_answers WHERE threadId=?').all(threadId).map(row => string(row.callId)); }
  beginAsyncAnswer(threadId: string, callId: string): boolean { return Number(this.db.prepare("INSERT OR IGNORE INTO async_answers(threadId,callId,at,status) VALUES(?,?,?,'sending')").run(threadId, callId, Date.now()).changes) > 0; }
  finishAsyncAnswer(threadId: string, callId: string, status: 'accepted' | 'rejected' | 'uncertain'): void {
    if (status === 'rejected') this.db.prepare("DELETE FROM async_answers WHERE threadId=? AND callId=? AND status='sending'").run(threadId, callId);
    else this.db.prepare('UPDATE async_answers SET status=?,at=? WHERE threadId=? AND callId=?').run(status, Date.now(), threadId, callId);
  }
  hostSince(threadId: string): number | undefined {
    const row = this.db.prepare('SELECT sinceMs FROM host_watch WHERE threadId=?').get(threadId);
    return row ? Number(row.sinceMs) : undefined;
  }
  trackHostQuestions(threadId: string, questions: import('./async-questions.js').AsyncQuestion[]): void {
    const pending = questions.filter(q => !this.asyncAnswered(threadId, q.callId));
    for (const q of questions) this.db.prepare('UPDATE async_answers SET at=? WHERE threadId=? AND callId=?').run(Date.now(), threadId, q.callId);
    if (!pending.length) { this.db.prepare('DELETE FROM host_watch WHERE threadId=?').run(threadId); return; }
    const since = Math.min(...pending.map(q => q.askedAtMs ?? Date.now()));
    this.db.prepare('INSERT INTO host_watch VALUES(?,?) ON CONFLICT(threadId) DO UPDATE SET sinceMs=MIN(sinceMs,excluded.sinceMs)').run(threadId, since);
  }
  questionAnswers(key: string, signature: string): Json {
    const row = this.db.prepare('SELECT answers FROM question_progress WHERE key=? AND signature=?').get(key, signature);
    return row ? object(JSON.parse(string(row.answers))) : {};
  }
  saveQuestionAnswers(key: string, signature: string, answers: Json): void {
    this.db.prepare('INSERT INTO question_progress VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET signature=excluded.signature,answers=excluded.answers,at=excluded.at').run(key, signature, JSON.stringify(answers), Date.now());
  }
  clearQuestionAnswers(key: string): void { this.db.prepare('DELETE FROM question_progress WHERE key=?').run(key); }
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
  streamingEnabled(): boolean { return this.db.prepare("SELECT value FROM settings WHERE key='streaming'").get()?.value !== 'off'; }
  setStreaming(enabled: boolean): void {
    this.db.prepare("INSERT INTO settings VALUES('streaming',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(enabled ? 'on' : 'off');
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
  enqueue(key: string, topicId: number | null, text: string, markup: Json | null = null, projectCwd?: string, sourceThreadId?: string): void {
    // A duplicate remains a no-op even while admission is full or after an uncertain send.
    if (this.db.prepare('SELECT 1 FROM outbox WHERE key=?').get(key)) return;
    if (text.length > 40_000) text = text.slice(0, 39_900) + '\n[Message shortened. See the terminal for the full answer.]';
    const durable = key.startsWith('final/') || key.startsWith('attention/');
    if (!durable && Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','blocked')").get()?.n ?? 0) >= MAX_ACTIVE_DELIVERIES) throw new Error('Delivery queue is full; check Telegram connectivity.');
    const binding = topicId === null ? undefined : this.topic(topicId);
    const blocked = binding && this.topicOperation(binding.threadId);
    // Final answers are durable before queue admission and remain outside the active-work cap.
    const status = blocked ? key.startsWith('prompt/') ? 'cancelled' : 'blocked' : durable ? 'deferred' : 'pending';
    this.db.prepare('INSERT OR IGNORE INTO outbox(key,topicId,text,markup,at,status,projectCwd,sourceThreadId) VALUES(?,?,?,?,?,?,?,?)').run(key, topicId, text, markup === null ? null : JSON.stringify(markup), Date.now(), status, projectCwd ?? binding?.cwd ?? null, sourceThreadId ?? binding?.threadId ?? null);
  }
  approvalCard(cardIdentity: string, identity: string, threadId: string, turnId: string, requestId: string | number, ownerToken: string): ApprovalCard {
    this.db.prepare("INSERT OR IGNORE INTO approval_requests VALUES(?,?,?,?,'pending',?)")
      .run(identity, threadId, turnId, JSON.stringify(requestId), Date.now());
    this.db.prepare('UPDATE approval_requests SET at=? WHERE identity=?').run(Date.now(), identity);
    this.db.prepare('INSERT OR IGNORE INTO approval_cards VALUES(?,?,?,?,?)').run(cardIdentity, `prompt/approval/card/${randomUUID()}`, identity, ownerToken, Date.now());
    this.db.prepare('UPDATE approval_cards SET ownerToken=?,at=? WHERE identity=?').run(ownerToken, Date.now(), cardIdentity);
    return this.db.prepare('SELECT r.identity,c.deliveryKey,r.status FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE c.identity=?').get(cardIdentity) as unknown as ApprovalCard;
  }
  approvalReceipt(key: string): { status: string; messageId: number | null; markup: Json | null } | undefined {
    const row = this.db.prepare('SELECT status,messageId,markup FROM outbox WHERE key=?').get(key);
    return row ? { status: string(row.status), messageId: typeof row.messageId === 'number' ? row.messageId : null,
      markup: typeof row.markup === 'string' ? object(JSON.parse(row.markup)) : null } : undefined;
  }
  approvalPending(identity: string): boolean { return this.db.prepare("SELECT status FROM approval_requests WHERE identity=?").get(identity)?.status === 'pending'; }
  ownsApprovalCard(key: string, ownerToken: string): boolean {
    return this.db.prepare('SELECT ownerToken FROM approval_cards WHERE deliveryKey=?').get(key)?.ownerToken === ownerToken;
  }
  invalidateApprovalMarkup(key: string): void { this.db.prepare("UPDATE outbox SET markup=NULL WHERE key=? AND status='sent'").run(key); }
  consumeApproval(identity: string): boolean {
    return Number(this.db.prepare("UPDATE approval_requests SET status='consumed',at=? WHERE identity=? AND status='pending'").run(Date.now(), identity).changes) === 1;
  }
  resolveApproval(threadId: string, requestId: string | number): void {
    this.db.prepare("UPDATE approval_requests SET status='resolved',at=? WHERE threadId=? AND requestId=?").run(Date.now(), threadId, JSON.stringify(requestId));
    this.cancelResolvedApprovalCards();
  }
  resolveApprovalTurn(threadId: string, turnId: string): void {
    this.db.prepare("UPDATE approval_requests SET status='resolved',at=? WHERE threadId=? AND (turnId=? OR turnId='')").run(Date.now(), threadId, turnId);
    this.cancelResolvedApprovalCards();
  }
  private cancelResolvedApprovalCards(): void {
    this.db.exec("UPDATE outbox SET status='cancelled' WHERE status IN ('pending','held') AND key IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='resolved')");
  }
  approvalMarkup(key: string, markup: Json, ownerToken: string): boolean {
    return Number(this.db.prepare(`UPDATE outbox SET markup=?,status=CASE WHEN status='held' THEN 'pending' ELSE status END
      WHERE key=? AND key IN (SELECT deliveryKey FROM approval_cards WHERE ownerToken=?) AND status IN ('pending','held','sent')
      AND (status!='held' OR (SELECT count(*) FROM outbox WHERE status IN ('pending','blocked'))<${MAX_ACTIVE_DELIVERIES})`)
      .run(JSON.stringify(markup), key, ownerToken).changes) > 0;
  }
  next(): Delivery | undefined {
    this.db.exec(`UPDATE outbox SET status='pending' WHERE id IN (
      SELECT id FROM outbox WHERE status='deferred' ORDER BY CASE WHEN key LIKE 'attention/%' THEN 0 ELSE 1 END,id
      LIMIT MAX(0,${MAX_ACTIVE_DELIVERIES}-(SELECT count(*) FROM outbox WHERE status='pending'))
    )`);
    const row = this.db.prepare(`SELECT *,${OWNER_NOTICE_SQL} AS ownerNotice FROM outbox WHERE status='pending' ORDER BY CASE WHEN key LIKE 'attention/%' THEN 0 ELSE 1 END,id LIMIT 1`).get();
    if (!row) return undefined;
    return {
      id: Number(row.id), key: string(row.key), topicId: row.topicId === null ? null : Number(row.topicId), text: string(row.text),
      markup: row.markup === null ? null : object(JSON.parse(string(row.markup))), projectCwd: typeof row.projectCwd === 'string' ? row.projectCwd : null,
      sourceThreadId: typeof row.sourceThreadId === 'string' ? row.sourceThreadId : null,
      ownerNotice: row.ownerNotice === 1,
      richPlan: typeof row.richPlan === 'string' ? JSON.parse(row.richPlan) as RichDeliveryPart[] : null,
      nextPart: Number(row.nextPart), messageId: row.messageId === null ? null : Number(row.messageId),
    };
  }
  sending(id: number): void { this.db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(id); }
  saveRichPlan(id: number, parts: RichDeliveryPart[]): void {
    this.db.prepare("UPDATE outbox SET richPlan=? WHERE id=? AND status='sending'").run(JSON.stringify(parts), id);
  }
  acceptRichPart(id: number, index: number, messageId: number | null): void {
    this.db.prepare("UPDATE outbox SET nextPart=?,messageId=? WHERE id=? AND status='sending' AND nextPart=?").run(index + 1, messageId, id, index);
  }
  delivered(id: number, messageId: number | null): void { this.db.prepare("UPDATE outbox SET status='sent',messageId=? WHERE id=?").run(messageId, id); }
  uncertain(id: number): void { this.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(id); }
  deliveryContexts(): DeliveryContext[] {
    return this.db.prepare(`SELECT DISTINCT topicId,projectCwd,sourceThreadId,${OWNER_NOTICE_SQL} AS ownerNotice FROM outbox WHERE status IN ('pending','blocked','deferred','held')`).all()
      .map(row => ({ topicId: row.topicId, projectCwd: row.projectCwd, sourceThreadId: row.sourceThreadId, ownerNotice: row.ownerNotice === 1 })) as DeliveryContext[];
  }
  cancelContext(context: DeliveryContext): void {
    this.db.prepare(`UPDATE outbox SET status='cancelled' WHERE topicId IS ? AND projectCwd IS ? AND sourceThreadId IS ? AND ${OWNER_NOTICE_SQL}=? AND status IN ('pending','blocked','deferred','held')`).run(context.topicId, context.projectCwd, context.sourceThreadId, context.ownerNotice ? 1 : 0);
  }
  cancelDelivery(id: number): void { this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=? AND status IN ('pending','blocked','deferred','sending')").run(id); }
  pendingFinalCount(): number { return Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE key LIKE 'final/%' AND status IN ('pending','blocked','deferred')").get()?.n ?? 0); }
  cancelPrompt(key: string): number | undefined {
    const id = this.promptMessage(key);
    this.db.prepare("UPDATE outbox SET status=CASE WHEN key IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending') THEN 'held' ELSE 'cancelled' END WHERE key=? AND status IN ('pending','held')").run(key);
    return typeof id === 'number' ? id : undefined;
  }
  promptMessage(key: string): number | undefined {
    const id = this.db.prepare('SELECT messageId FROM outbox WHERE key=?').get(key)?.messageId;
    return typeof id === 'number' ? id : undefined;
  }
  uncertainCount(): number {
    const files = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_jobs'").get()
      ? Number(this.db.prepare("SELECT count(*) AS n FROM file_jobs WHERE status='uncertain'").get()?.n ?? 0) : 0;
    return files + Number(this.db.prepare("SELECT (SELECT count(*) FROM incoming WHERE status='uncertain')+(SELECT count(*) FROM outbox WHERE status='uncertain') AS n").get()?.n ?? 0);
  }
  prune(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM incoming WHERE at<? AND status IN ('done','rejected')").run(cutoff);
    this.db.prepare("DELETE FROM outbox WHERE at<? AND status IN ('sent','cancelled') AND key NOT IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status IN ('pending','consumed'))").run(cutoff);
    this.db.prepare("DELETE FROM approval_cards WHERE at<? AND requestIdentity IN (SELECT identity FROM approval_requests WHERE status='resolved') AND deliveryKey NOT IN (SELECT key FROM outbox WHERE status='uncertain')").run(cutoff);
    this.db.prepare("DELETE FROM approval_requests WHERE status='resolved' AND at<? AND identity NOT IN (SELECT requestIdentity FROM approval_cards)").run(cutoff);
    this.db.prepare('DELETE FROM async_answers WHERE at<? AND threadId NOT IN (SELECT threadId FROM host_watch)').run(cutoff);
    this.db.prepare('DELETE FROM question_progress WHERE at<?').run(cutoff);
  }
}
