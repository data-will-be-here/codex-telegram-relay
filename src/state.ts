import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './config.js';
import { object, string, type Binding, type Json, type MessageMode } from './types.js';
import { type ViewMode, type WidgetCard, type WidgetDelivery } from './widget-types.js';
import { type FormattedText } from './format.js';

const MAX_ACTIVE_DELIVERIES = 1000;
const OWNER_NOTICE_SQL = "(projectCwd IS NULL AND sourceThreadId IS NULL AND (key LIKE 'notice/%' OR key LIKE 'attention/status/%'))";
const SETTLED_WIDGET_SQL = "(everUncertain=0 AND (delivery IN ('retired','disabled') OR (delivery='new' AND json_extract(payload,'$.snapshot.finishedAt') IS NOT NULL) OR (delivery='active' AND json_extract(payload,'$.snapshot.finishedAt') IS NOT NULL AND sentRevision>=CAST(json_extract(payload,'$.revision') AS INTEGER))))";

export interface RichDeliveryPart { method: 'sendRichMessage' | 'sendMessage' | 'sendWidget'; params: Json; fallback?: string; fallbackText?: FormattedText; }
export interface Delivery {
  projectLabel?: string | undefined;
  sessionName?: string | null;
  id: number; key: string; topicId: number | null; text: string; markup: Json | null; projectCwd: string | null;
  sourceThreadId: string | null;
  ownerNotice: boolean;
  richPlan: RichDeliveryPart[] | null; nextPart: number; messageId: number | null;
}
export interface DeliveryContext { topicId: number | null; projectCwd: string | null; sourceThreadId: string | null; ownerNotice: boolean; }
export interface TopicOperation {
  threadId: string; cwd: string; title: string; attempt: string;
  status: 'missing' | 'creating' | 'uncertain' | 'failed' | 'retry'; retryAt: number;
  error?: string | null;
}
export interface ApprovalCard { identity: string; deliveryKey: string; status: string; }

export type NewSessionPhase = 'selecting' | 'cancelled' | 'checking' | 'preparing' | 'starting' | 'uncertain' | 'known' | 'persisted' | 'topic' | 'ready' | 'failed';
export interface NewSessionOperation {
  reset?: Binding;
  id: string; status: NewSessionPhase; topicId: number | null; menuKey: string; token: string; expires: number;
  choices: { cwd: string; label: string; kind: 'project' | 'scratch' }[]; page: number;
  reportedTopicAttempt?: string;
  topicFirst?: boolean; targetTopic?: number; topicTitle?: string; topicAttempt?: number;
  topicState?: 'creating' | 'retry' | 'failed' | 'uncertain' | 'ready'; topicFailure?: string; topicReport?: string;
  kind?: 'project' | 'scratch'; root?: string; cwd?: string; threadId?: string; name?: string;
  retryAt?: number; error?: string;
}

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
        CREATE TABLE IF NOT EXISTS new_sessions(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS retired_bindings(threadId TEXT PRIMARY KEY, binding TEXT NOT NULL, replacementId TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS widget_cards(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, turnId TEXT NOT NULL, payload TEXT NOT NULL,
          delivery TEXT NOT NULL DEFAULT 'new', messageId INTEGER, sentRevision INTEGER NOT NULL DEFAULT 0,
          retryAt INTEGER NOT NULL DEFAULT 0, lastSentAt INTEGER NOT NULL DEFAULT 0, everUncertain INTEGER NOT NULL DEFAULT 0, UNIQUE(threadId,turnId));
        CREATE TABLE IF NOT EXISTS widget_answers(deliveryKey TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, text TEXT NOT NULL, messageId INTEGER);
        CREATE INDEX IF NOT EXISTS new_sessions_status ON new_sessions(status);
        CREATE UNIQUE INDEX IF NOT EXISTS new_sessions_thread ON new_sessions(json_extract(payload,'$.threadId'));
        CREATE INDEX IF NOT EXISTS new_sessions_token ON new_sessions(json_extract(payload,'$.token'));
        CREATE INDEX IF NOT EXISTS new_sessions_workspace ON new_sessions(json_extract(payload,'$.cwd'),status);
        UPDATE new_sessions SET status='uncertain' WHERE status='starting';
        UPDATE new_sessions SET status='failed' WHERE status='checking';
        UPDATE topic_operations SET status='uncertain' WHERE status='creating';
        UPDATE incoming SET status='uncertain' WHERE status='dispatching';
        UPDATE outbox SET status='uncertain' WHERE status='sending';
        UPDATE outbox SET status='held' WHERE status='pending' AND key IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending');
        UPDATE outbox SET status='cancelled' WHERE status='pending' AND key LIKE 'prompt/%';`);
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'projectCwd')) this.db.exec('ALTER TABLE outbox ADD COLUMN projectCwd TEXT');
      if (!this.db.prepare('PRAGMA table_info(bindings)').all().some(column => column.name === 'sessionName')) this.db.exec('ALTER TABLE bindings ADD COLUMN sessionName TEXT');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'sessionName')) this.db.exec('ALTER TABLE outbox ADD COLUMN sessionName TEXT');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'richPlan')) this.db.exec('ALTER TABLE outbox ADD COLUMN richPlan TEXT');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'nextPart')) this.db.exec('ALTER TABLE outbox ADD COLUMN nextPart INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'retryAt')) this.db.exec('ALTER TABLE outbox ADD COLUMN retryAt INTEGER NOT NULL DEFAULT 0');
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
      if (!this.db.prepare('PRAGMA table_info(widget_cards)').all().some(column => column.name === 'everUncertain')) this.db.exec('ALTER TABLE widget_cards ADD COLUMN everUncertain INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(widget_answers)').all().some(column => column.name === 'fallbackQueued')) this.db.exec('ALTER TABLE widget_answers ADD COLUMN fallbackQueued INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(widget_answers)').all().some(column => column.name === 'multipartSafe')) this.db.exec('ALTER TABLE widget_answers ADD COLUMN multipartSafe INTEGER NOT NULL DEFAULT 0');
      const legacyWidgets = !this.db.prepare('PRAGMA table_info(widget_cards)').all().some(column => column.name === 'failure');
      if (legacyWidgets) this.db.exec('ALTER TABLE widget_cards ADD COLUMN failure TEXT');
      const interruptedWidgets = new Set(this.db.prepare("SELECT id FROM widget_cards WHERE delivery='sending' OR (? AND delivery='uncertain')").all(Number(legacyWidgets)).map(row => row.id));
      this.db.prepare("UPDATE settings SET value='classic' WHERE key IN (SELECT 'view/' || threadId FROM widget_cards WHERE delivery='sending' OR (? AND delivery='uncertain'))").run(Number(legacyWidgets));
      this.db.exec("UPDATE widget_cards SET delivery='uncertain',failure='restart-outcome-unknown' WHERE delivery='sending'; UPDATE widget_cards SET delivery='active' WHERE delivery='editing'; UPDATE widget_cards SET failure='legacy-outcome-unknown' WHERE delivery='uncertain' AND failure IS NULL");
      if (!this.db.prepare('PRAGMA table_info(topic_operations)').all().some(column => column.name === 'error')) this.db.exec('ALTER TABLE topic_operations ADD COLUMN error TEXT');
      this.db.exec("UPDATE topic_operations SET status='uncertain' WHERE status='failed' AND error LIKE '%BOT_TOPIC_WRONG_HOME%'");
      this.db.exec("UPDATE widget_cards SET everUncertain=1 WHERE delivery='uncertain'");
      for (const card of this.widgetCards().filter(card => interruptedWidgets.has(card.id))) {
        this.enqueue(`attention/widgets/${card.id}`, card.binding.topicId,
          'Widget delivery could not be confirmed and will not be repeated. Classic view selected for following turns; replies and approvals continue normally. Use /view widgets to enable cards again.');
      }
      const unsettledAnswers = this.db.prepare(`SELECT o.id,o.messageId,o.nextPart,a.multipartSafe,json_array_length(o.richPlan) AS parts FROM outbox o
        JOIN widget_answers a ON a.deliveryKey=o.key WHERE o.status='uncertain'`).all();
      for (const row of unsettledAnswers) {
        if (typeof row.messageId === 'number' && row.messageId > 0) {
          if (Number(row.nextPart) >= Number(row.parts)) this.delivered(Number(row.id), row.messageId);
          else if (row.multipartSafe === 1) this.db.prepare("UPDATE outbox SET status='pending',retryAt=0 WHERE id=?").run(Number(row.id));
          else this.fallbackWidgetAnswer(Number(row.id));
        }
        else this.fallbackWidgetAnswer(Number(row.id));
      }
      this.prune();
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  close(): void {
    this.db.close();
    if (existsSync(this.lock) && readFileSync(this.lock, 'utf8') === this.lockValue) unlinkSync(this.lock);
  }
  viewMode(threadId: string): ViewMode { return this.db.prepare('SELECT value FROM settings WHERE key=?').get('view/' + threadId)?.value === 'widgets' ? 'widgets' : 'classic'; }
  setViewMode(threadId: string, view: ViewMode): void {
    if (!threadId || !['classic', 'widgets'].includes(view)) throw new Error('Invalid session view.');
    this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('view/' + threadId, view);
  }
  widgetCards(threadId?: string): WidgetDelivery[] {
    return this.db.prepare('SELECT * FROM widget_cards' + (threadId ? ' WHERE threadId=?' : '') + ' ORDER BY rowid').all(...(threadId ? [threadId] : [])).map(row => this.decodeWidget(row)!);
  }
  private decodeWidget(value: unknown): WidgetDelivery | undefined {
    if (!value) return;
    const row = object(value);
    return { ...JSON.parse(string(row.payload)), delivery: row.delivery, messageId: row.messageId, sentRevision: row.sentRevision,
      retryAt: row.retryAt, lastSentAt: row.lastSentAt, failure: row.failure } as WidgetDelivery;
  }
  widgetCard(threadId: string, turnId: string): WidgetDelivery | undefined {
    return this.decodeWidget(this.db.prepare('SELECT * FROM widget_cards WHERE threadId=? AND turnId=?').get(threadId, turnId));
  }
  activeWidget(threadId: string, generation: string): WidgetDelivery | undefined {
    return this.decodeWidget(this.db.prepare("SELECT * FROM widget_cards WHERE threadId=? AND json_extract(payload,'$.generation')=? AND json_extract(payload,'$.snapshot.finishedAt') IS NULL ORDER BY rowid DESC LIMIT 1").get(threadId, generation));
  }
  activeWidgets(generation: string): WidgetDelivery[] {
    return this.db.prepare("SELECT * FROM widget_cards WHERE json_extract(payload,'$.generation')=? AND json_extract(payload,'$.view')='widgets' AND json_extract(payload,'$.snapshot.finishedAt') IS NULL AND json_extract(payload,'$.snapshot.status') IN ('working','approval','answer','unavailable','disconnected')")
      .all(generation).map(row => this.decodeWidget(row)!);
  }
  nextWidgetDelivery(generation: string, now: number): WidgetDelivery | undefined {
    return this.decodeWidget(this.db.prepare(`SELECT * FROM widget_cards WHERE json_extract(payload,'$.generation')=? AND json_extract(payload,'$.view')='widgets' AND retryAt<=? AND
      ((delivery='new' AND json_extract(payload,'$.snapshot.finishedAt') IS NULL AND CAST(json_extract(payload,'$.createdAt') AS INTEGER)<=?) OR
       (delivery='active' AND CAST(json_extract(payload,'$.revision') AS INTEGER)>sentRevision AND lastSentAt<=?))
      ORDER BY lastSentAt,CAST(json_extract(payload,'$.createdAt') AS INTEGER) LIMIT 1`).get(generation, now, now - 1000, now - 2500));
  }
  saveWidget(card: WidgetCard): boolean {
    // Never evict a live, in-flight or uncertain receipt to admit new work.
    this.db.prepare(`DELETE FROM widget_cards WHERE id<>? AND ${SETTLED_WIDGET_SQL} AND CAST(json_extract(payload,'$.snapshot.updatedAt') AS INTEGER)<?`).run(card.id, Date.now() - 7 * 86400_000);
    if (!this.widgetCard(card.binding.threadId, card.turnId)) {
      const size = Number(this.db.prepare('SELECT count(*) AS n FROM widget_cards').get()?.n ?? 0);
      if (size >= 512) this.db.prepare(`DELETE FROM widget_cards WHERE rowid IN (SELECT rowid FROM widget_cards WHERE ${SETTLED_WIDGET_SQL} ORDER BY rowid LIMIT ?)`).run(size - 511);
      if (Number(this.db.prepare('SELECT count(*) AS n FROM widget_cards').get()?.n ?? 0) >= 512) return false;
    }
    const payload: WidgetCard = { id: card.id, token: card.token, generation: card.generation, binding: card.binding, turnId: card.turnId,
      view: card.view, revision: card.revision, createdAt: card.createdAt, snapshot: card.snapshot };
    this.db.prepare('INSERT INTO widget_cards(id,threadId,turnId,payload) VALUES(?,?,?,?) ON CONFLICT(threadId,turnId) DO UPDATE SET payload=excluded.payload')
      .run(card.id, card.binding.threadId, card.turnId, JSON.stringify(payload));
    return true;
  }
  claimWidget(id: string, editing: boolean): boolean {
    return !!this.db.prepare('UPDATE widget_cards SET delivery=? WHERE id=? AND delivery=?').run(editing ? 'editing' : 'sending', id, editing ? 'active' : 'new').changes;
  }
  widgetDelivered(id: string, revision: number, messageId: number, now: number): void {
    this.db.prepare("UPDATE widget_cards SET delivery=CASE WHEN delivery='retired' THEN 'retired' ELSE 'active' END,messageId=?,sentRevision=MAX(sentRevision,?),retryAt=0,lastSentAt=?,failure=NULL WHERE id=?")
      .run(messageId, revision, now, id);
  }
  widgetResult(id: string, delivery: WidgetDelivery['delivery'], retryAt = 0, failure: string | null = null): void {
    this.db.prepare("UPDATE widget_cards SET delivery=?,retryAt=?,failure=COALESCE(?,failure),everUncertain=MAX(everUncertain,CASE WHEN ?='uncertain' THEN 1 ELSE 0 END) WHERE id=?").run(delivery, retryAt, failure, delivery, id);
  }
  newSessions(phases?: readonly NewSessionPhase[]): NewSessionOperation[] {
    const rows = phases ? this.db.prepare(`SELECT * FROM new_sessions WHERE status IN (${phases.map(() => '?').join(',')})`).all(...phases) : this.db.prepare('SELECT * FROM new_sessions').all();
    return rows.map(row => ({ ...JSON.parse(string(row.payload)), status: row.status }) as NewSessionOperation);
  }
  findNewSession(field: 'token' | 'threadId', value: string): NewSessionOperation | undefined {
    const row = this.db.prepare(`SELECT * FROM new_sessions WHERE json_extract(payload,'$.${field}')=? LIMIT 1`).get(value);
    return row ? { ...JSON.parse(string(row.payload)), status: row.status } as NewSessionOperation : undefined;
  }
  newSession(id: string): NewSessionOperation | undefined {
    const row = this.db.prepare('SELECT * FROM new_sessions WHERE id=?').get(id);
    return row ? { ...JSON.parse(string(row.payload)), status: row.status } as NewSessionOperation : undefined;
  }
  createNewSession(operation: NewSessionOperation): void {
    this.db.prepare('INSERT INTO new_sessions VALUES(?,?,?)').run(operation.id, operation.status, JSON.stringify(operation));
  }
  changeNewSession(id: string, expected: NewSessionPhase, patch: Partial<NewSessionOperation>): NewSessionOperation | undefined {
    const previous = this.newSession(id);
    if (!previous || previous.status !== expected) return;
    const next = { ...previous, ...patch, id };
    return this.db.prepare('UPDATE new_sessions SET status=?,payload=? WHERE id=? AND status=?').run(next.status, JSON.stringify(next), id, expected).changes ? next : undefined;
  }
  ownsScratch(cwd: string, threadId?: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM new_sessions WHERE json_extract(payload,'$.cwd')=? AND json_extract(payload,'$.kind')='scratch' AND json_extract(payload,'$.threadId') IS NOT NULL AND status IN ('persisted','topic','ready')" +
      (threadId ? " AND json_extract(payload,'$.threadId')=?" : '') + ' LIMIT 1').get(cwd, ...(threadId ? [threadId] : []));
  }
  workspaceLabel(cwd?: string | null): string | undefined { return cwd && this.ownsScratch(cwd) ? 'No project' : undefined; }
  retiredSession(threadId: string): boolean { return !!this.db.prepare('SELECT 1 FROM retired_bindings WHERE threadId=?').get(threadId); }
  resettingTopic(topicId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM new_sessions WHERE json_extract(payload,'$.reset.topicId')=? AND status NOT IN ('ready','failed','cancelled') LIMIT 1").get(topicId);
  }
  historicalAnswerBinding(binding: Binding): boolean {
    const current = this.topic(binding.topicId);
    if (!current || current.cwd !== binding.cwd) return false;
    let id = binding.threadId;
    for (let depth = 0; depth < 256; depth++) {
      if (id === current.threadId) return true;
      const row = this.db.prepare('SELECT binding,replacementId FROM retired_bindings WHERE threadId=?').get(id);
      if (!row) return false;
      const saved = JSON.parse(string(row.binding)) as Binding;
      if (saved.topicId !== binding.topicId || saved.cwd !== binding.cwd) return false;
      id = string(row.replacementId);
    }
    return false;
  }
  sessionDeliveryBusy(threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE sourceThreadId=? AND status IN ('pending','blocked','deferred','held','sending') LIMIT 1").get(threadId) ||
      !!this.db.prepare("SELECT 1 FROM widget_cards WHERE threadId=? AND delivery IN ('sending','editing') LIMIT 1").get(threadId) ||
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_jobs'").get() &&
      !!this.db.prepare("SELECT 1 FROM file_jobs WHERE threadId=? AND status IN ('preparing','pending','sending') LIMIT 1").get(threadId);
  }
  resetTopic(operation: NewSessionOperation): Binding {
    const old = operation.reset; const id = operation.threadId;
    if (!old || !id) throw new Error('Invalid reset operation.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.topic(old.topicId);
      if (current?.threadId === id && this.retiredSession(old.threadId)) { this.db.exec('COMMIT'); return current; }
      if (current?.threadId !== old.threadId || current.cwd !== old.cwd || this.sessionDeliveryBusy(old.threadId)) throw new Error('The previous topic is busy or its binding changed.');
      this.db.prepare('INSERT INTO retired_bindings VALUES(?,?,?)').run(old.threadId, JSON.stringify(old), id);
      this.db.prepare("UPDATE widget_cards SET delivery='retired' WHERE threadId=?").run(old.threadId);
      this.db.prepare('DELETE FROM bindings WHERE threadId=?').run(old.threadId);
      this.db.prepare("INSERT INTO bindings(threadId,topicId,cwd,title,lastTurn,sessionName) VALUES(?,?,?,?,'-',?)").run(id, old.topicId, old.cwd, old.title, operation.name ?? null);
      this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('view/' + id, this.viewMode(old.threadId));
      this.db.prepare('DELETE FROM topic_operations WHERE threadId IN (?,?)').run(old.threadId, id);
      this.db.prepare('DELETE FROM replies WHERE threadId=?').run(old.threadId);
      this.db.exec('COMMIT'); return this.binding(id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private describeBinding(binding: Binding | undefined): Binding | undefined {
    return binding ? { ...binding, ...(this.workspaceLabel(binding.cwd) ? { projectLabel: 'No project' } : {}) } : undefined;
  }
  bindings(): Binding[] { return (this.db.prepare('SELECT * FROM bindings').all() as unknown as Binding[]).map(binding => this.describeBinding(binding)!); }
  binding(threadId: string): Binding | undefined { return this.describeBinding(this.db.prepare('SELECT * FROM bindings WHERE threadId=?').get(threadId) as unknown as Binding | undefined); }
  topic(topicId: number): Binding | undefined { return this.describeBinding(this.db.prepare('SELECT * FROM bindings WHERE topicId=?').get(topicId) as unknown as Binding | undefined); }
  bind(threadId: string, topicId: number, cwd: string, title: string): void {
    this.db.prepare('INSERT INTO bindings(threadId,topicId,cwd,title) VALUES(?,?,?,?)').run(threadId, topicId, cwd, title);
  }
  topicOperations(): TopicOperation[] { return this.db.prepare('SELECT * FROM topic_operations').all() as unknown as TopicOperation[]; }
  topicOperation(threadId: string): TopicOperation | undefined { return this.db.prepare('SELECT * FROM topic_operations WHERE threadId=?').get(threadId) as unknown as TopicOperation | undefined; }
  beginTopic(threadId: string, cwd: string, title: string): TopicOperation | undefined {
    const previous = this.topicOperation(threadId);
    if (previous && (['creating', 'uncertain', 'failed'].includes(previous.status) || previous.retryAt > Date.now())) return undefined;
    this.db.prepare("INSERT INTO topic_operations(threadId,cwd,title,attempt,status,retryAt) VALUES(?,?,?,?,'creating',0) ON CONFLICT(threadId) DO UPDATE SET cwd=excluded.cwd,title=excluded.title,attempt=excluded.attempt,status='creating',retryAt=0,error=NULL").run(threadId, cwd, title, randomUUID());
    return this.topicOperation(threadId);
  }
  topicResult(threadId: string, attempt: string, status: TopicOperation['status'], retryAt = 0, error: string | null = null): void {
    this.db.prepare('UPDATE topic_operations SET status=?,retryAt=?,error=? WHERE threadId=? AND attempt=?').run(status, retryAt, error, threadId, attempt);
  }
  retryTopic(threadId: string): void {
    this.db.prepare("UPDATE topic_operations SET status='missing',retryAt=0 WHERE threadId=? AND status!='creating'").run(threadId);
  }
  missingTopic(binding: Binding): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT OR IGNORE INTO topic_operations(threadId,cwd,title,attempt,status,retryAt) VALUES(?,?,?,?,'missing',0)").run(binding.threadId, binding.cwd, binding.title, randomUUID());
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
  baselineIfCurrent(threadId: string, turnId: string, expected: string | null): void {
    this.db.prepare('UPDATE bindings SET lastTurn=? WHERE threadId=? AND lastTurn IS ?').run(turnId, threadId, expected);
  }
  deliveryExists(key: string): boolean { return !!this.db.prepare('SELECT 1 FROM outbox WHERE key=? UNION ALL SELECT 1 FROM widget_answers WHERE deliveryKey=? LIMIT 1').get(key, key); }
  enqueueWidgetAnswer(key: string, binding: Binding, text: string, token: string, part: RichDeliveryPart | RichDeliveryPart[]): boolean {
    if (this.deliveryExists(key)) return true;
    if (Number(this.db.prepare('SELECT count(*) AS n FROM widget_answers').get()?.n ?? 0) >= 10_000) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.enqueue(key, binding.topicId, text, null, binding.cwd, binding.threadId);
      this.db.prepare('INSERT INTO widget_answers(deliveryKey,token,binding,text,multipartSafe) VALUES(?,?,?,?,1)').run(key, token, JSON.stringify(binding), text);
      this.db.prepare('UPDATE outbox SET text=?,richPlan=? WHERE key=?').run(text, JSON.stringify(Array.isArray(part) ? part : [part]), key);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  widgetAnswer(token: string): { binding: Binding; text: string; messageId: number | null } | undefined {
    const row = this.db.prepare(`SELECT a.binding,a.text,COALESCE(a.messageId,CASE WHEN json_extract(o.richPlan,'$[0].method')='sendWidget' THEN o.messageId END) AS receipt
      FROM widget_answers a LEFT JOIN outbox o ON o.key=a.deliveryKey WHERE a.token=?`).get(token);
    return row ? { binding: JSON.parse(string(row.binding)) as Binding, text: string(row.text), messageId: typeof row.receipt === 'number' ? row.receipt : null } : undefined;
  }
  isWidgetAnswer(key: string): boolean { return !!this.db.prepare('SELECT 1 FROM widget_answers WHERE deliveryKey=?').get(key); }
  retryDelivery(id: number, retryAt: number): void { this.db.prepare("UPDATE outbox SET status='pending',retryAt=? WHERE id=? AND status='sending'").run(retryAt, id); }
  fallbackWidgetAnswer(id: number): void {
    const row = this.db.prepare(`SELECT o.key,o.topicId,o.projectCwd,o.sourceThreadId,a.text,a.fallbackQueued
      FROM outbox o JOIN widget_answers a ON a.deliveryKey=o.key WHERE o.id=?`).get(id);
    if (!row || row.fallbackQueued) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof row.sourceThreadId === 'string') this.setViewMode(row.sourceThreadId, 'classic');
      this.uncertain(id);
      this.enqueue(`attention/final-widget-fallback/${string(row.key)}`, typeof row.topicId === 'number' ? row.topicId : null,
        `The result card could not be confirmed. Full reply:\n\n${string(row.text)}`, null, typeof row.projectCwd === 'string' ? row.projectCwd : undefined,
        typeof row.sourceThreadId === 'string' ? row.sourceThreadId : undefined);
      this.db.prepare('UPDATE widget_answers SET fallbackQueued=1 WHERE deliveryKey=?').run(row.key as string);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
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
  sessionName(threadId: string, name: string): void {
    const label = Array.from(name.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('') || threadId.slice(0, 8);
    this.db.prepare('UPDATE bindings SET sessionName=? WHERE threadId=?').run(label, threadId);
  }
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
  enqueueOwnerNotice(key: string, topicId: number | null, text: string, markup: Json | null = null): void {
    if (!key.startsWith('notice/')) throw new Error('Owner notices require a notice key.');
    this.enqueue(key, null, text, markup);
    this.db.prepare("UPDATE outbox SET topicId=? WHERE key=? AND projectCwd IS NULL AND sourceThreadId IS NULL AND status='pending'").run(topicId, key);
  }
  enqueue(key: string, topicId: number | null, text: string, markup: Json | null = null, projectCwd?: string, sourceThreadId?: string): void {
    // A duplicate remains a no-op even while admission is full or after an uncertain send.
    if (this.deliveryExists(key)) return;
    const approval = key.startsWith('prompt/approval/') && this.db.prepare('SELECT 1 FROM approval_cards WHERE deliveryKey=?').get(key);
    const cachedAnswer = /^(?:attention\/widget-answer|attention\/final-widget-fallback)\//u.test(key);
    if (!approval && !cachedAnswer && text.length > 40_000) text = text.slice(0, 39_900) + '\n[Message shortened. See the terminal for the full answer.]';
    const durable = key.startsWith('final/') || key.startsWith('attention/');
    if (!durable && Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','blocked')").get()?.n ?? 0) >= MAX_ACTIVE_DELIVERIES) throw new Error('Delivery queue is full; check Telegram connectivity.');
    const binding = topicId === null ? undefined : this.topic(topicId);
    const blocked = binding && this.topicOperation(binding.threadId);
    // Final answers are durable before queue admission and remain outside the active-work cap.
    const status = blocked ? key.startsWith('prompt/') ? 'cancelled' : 'blocked' : durable ? 'deferred' : 'pending';
    const sessionName = binding?.sessionName ?? (sourceThreadId ? this.binding(sourceThreadId)?.sessionName : null) ?? null;
    this.db.prepare('INSERT OR IGNORE INTO outbox(key,topicId,text,markup,at,status,projectCwd,sourceThreadId,sessionName) VALUES(?,?,?,?,?,?,?,?,?)').run(key, topicId, text, markup === null ? null : JSON.stringify(markup), Date.now(), status, projectCwd ?? binding?.cwd ?? null, sourceThreadId ?? binding?.threadId ?? null, sessionName);
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
  approvalDeliveryActive(key: string): boolean {
    const row = this.db.prepare(`SELECT r.status AS requestStatus,o.status AS deliveryStatus FROM approval_cards c
      JOIN approval_requests r ON r.identity=c.requestIdentity JOIN outbox o ON o.key=c.deliveryKey WHERE c.deliveryKey=?`).get(key);
    return !row || row.requestStatus === 'pending' && row.deliveryStatus === 'sending';
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
    this.db.exec("UPDATE outbox SET status='cancelled' WHERE status IN ('pending','held','sending') AND key IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='resolved')");
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
    const row = this.db.prepare(`SELECT *,${OWNER_NOTICE_SQL} AS ownerNotice FROM outbox WHERE status='pending' AND retryAt<=? ORDER BY CASE WHEN key LIKE 'attention/%' OR key LIKE 'prompt/%' THEN 0 ELSE 1 END,id LIMIT 1`).get(Date.now());
    if (!row) return undefined;
    return {
      id: Number(row.id), key: string(row.key), topicId: row.topicId === null ? null : Number(row.topicId), text: string(row.text),
      markup: row.markup === null ? null : object(JSON.parse(string(row.markup))), projectCwd: typeof row.projectCwd === 'string' ? row.projectCwd : null,
      sourceThreadId: typeof row.sourceThreadId === 'string' ? row.sourceThreadId : null,
      sessionName: typeof row.sessionName === 'string' ? row.sessionName : null,
      projectLabel: this.workspaceLabel(typeof row.projectCwd === 'string' ? row.projectCwd : null),
      ownerNotice: row.ownerNotice === 1,
      richPlan: typeof row.richPlan === 'string' ? JSON.parse(row.richPlan) as RichDeliveryPart[] : null,
      nextPart: Number(row.nextPart), messageId: row.messageId === null ? null : Number(row.messageId),
    };
  }
  sending(id: number): void {
    this.db.prepare(`UPDATE outbox SET status='sending',messageId=CASE WHEN key IN (SELECT deliveryKey FROM widget_answers) THEN NULL ELSE messageId END
      WHERE id=? AND status='pending'`).run(id);
  }
  saveRichPlan(id: number, parts: RichDeliveryPart[]): void {
    this.db.prepare("UPDATE outbox SET richPlan=? WHERE id=? AND status='sending'").run(JSON.stringify(parts), id);
  }
  acceptRichPart(id: number, index: number, messageId: number | null): void {
    this.db.prepare("UPDATE outbox SET nextPart=?,messageId=? WHERE id=? AND status='sending' AND nextPart=?").run(index + 1, messageId, id, index);
  }
  acceptApprovalPart(id: number, index: number, messageId: number): boolean {
    // Retirement can hold an in-flight send. Keep its receipt without releasing the hold.
    return this.db.prepare(`UPDATE outbox SET nextPart=?,messageId=?,status=CASE WHEN status='sending' THEN 'pending' ELSE status END
      WHERE id=? AND status IN ('sending','pending','held') AND nextPart=? AND key IN (
        SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending') RETURNING status`)
      .get(index + 1, messageId, id, index)?.status === 'pending';
  }
  pauseApprovalPart(id: number, index: number, retryAt: number): boolean {
    return this.db.prepare(`UPDATE outbox SET status=CASE WHEN status='sending' THEN 'pending' ELSE status END,retryAt=?
      WHERE id=? AND status IN ('sending','pending','held') AND nextPart=? AND key IN (
        SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending') RETURNING status`)
      .get(retryAt, id, index)?.status === 'pending';
  }
  completeApprovalDelivery(id: number, parts: number): void {
    this.db.prepare(`UPDATE outbox SET status='sent',markup=NULL WHERE id=? AND status IN ('sending','pending')
      AND nextPart=? AND messageId IS NOT NULL AND key IN (
        SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending')`).run(id, parts);
  }
  delivered(id: number, messageId: number | null): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE outbox SET status='sent',messageId=? WHERE id=?").run(messageId, id);
      this.db.prepare(`UPDATE widget_answers SET messageId=? WHERE deliveryKey IN (SELECT key FROM outbox WHERE id=? AND json_extract(richPlan,'$[0].method')='sendWidget')`).run(messageId, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
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
    this.db.prepare("UPDATE outbox SET status=CASE WHEN key IN (SELECT c.deliveryKey FROM approval_cards c JOIN approval_requests r ON r.identity=c.requestIdentity WHERE r.status='pending') THEN 'held' ELSE 'cancelled' END WHERE key=? AND status IN ('pending','held','sending')").run(key);
    return typeof id === 'number' ? id : undefined;
  }
  promptMessage(key: string): number | undefined {
    const id = this.db.prepare('SELECT messageId FROM outbox WHERE key=?').get(key)?.messageId;
    return typeof id === 'number' ? id : undefined;
  }
  uncertainCount(): number {
    const files = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_jobs'").get()
      ? Number(this.db.prepare("SELECT count(*) AS n FROM file_jobs WHERE status='uncertain'").get()?.n ?? 0) : 0;
    return files + Number(this.db.prepare("SELECT (SELECT count(*) FROM incoming WHERE status='uncertain')+(SELECT count(*) FROM outbox WHERE status='uncertain')+(SELECT count(*) FROM widget_cards WHERE everUncertain=1) AS n").get()?.n ?? 0);
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
