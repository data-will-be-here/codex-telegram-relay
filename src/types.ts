export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
export type MessageMode = 'all' | 'compact';
export type UserInput = { type: 'text'; text: string } | { type: 'localImage'; path: string };

export interface Session {
  threadSource?: string;
  id: string;
  cwd: string;
  name: string;
  status: string;
  createdAt?: number;
  activeTurnId?: string;
}

export interface Binding {
  projectLabel?: string | undefined;
  sessionName?: string | null;
  threadId: string;
  topicId: number;
  cwd: string;
  title: string;
  lastTurn: string | null;
}

export interface RpcRequest {
  id: string | number;
  method: string;
  params: Json;
}

export interface AgentOrigin { threadId: string; name: string; }
export interface ModelSettings { model: string; effort?: string; serviceTier: string; }
export interface PermissionPatch { permissions?: string; approvalPolicy?: 'on-request' | 'never'; approvalsReviewer?: 'user' | 'auto_review'; }
export interface PermissionSnapshot { settings: Json; profiles: Json[]; requirements: Json; autoReview: boolean; }

export interface Codex {
  permissionCatalog?(threadId: string, cwd: string): Promise<PermissionSnapshot>;
  updatePermissions?(threadId: string, patch: PermissionPatch, expected: string): Promise<void>;
  createThread?(cwd: string, marker: string, source?: 'clear'): Promise<Json>;
  setThreadName?(threadId: string, name: string): Promise<void>;
  storedThreads?(cwd: string): Promise<Json[]>;
  nonArchivedThread?(threadId: string): Promise<Json | undefined>;
  findCreatedThread?(cwd: string, marker: string): Promise<Json | undefined>;
  rateLimits(): Promise<Json>;
  models(): Promise<Json[]>;
  updateSettings(threadId: string, settings: ModelSettings): Promise<void>;
  loaded?(): Promise<string[]>;
  asyncQuestions?(threadId: string, historySinceMs?: number, answeredCallIds?: readonly string[]): Promise<import('./async-questions.js').AsyncQuestion[]>;
  list(eligible?: (session: Session) => boolean): Promise<Session[]>;
  attach(threadId: string): Promise<Json>;
  read(threadId: string, timeoutMs?: number): Promise<Json>;
  turns(threadId: string, timeoutMs?: number): Promise<Json[]>;
  start(threadId: string, text: string | UserInput[]): Promise<unknown>;
  steer(threadId: string, turnId: string, text: string | UserInput[]): Promise<unknown>;
  respond(id: string | number, result: Json): Promise<void>;
  hasRequest(id: string | number): boolean;
}

export interface Telegram {
  upload?(method: 'sendVideo' | 'sendDocument', params: Json, file: { name: string; bytes: Buffer }, signal: AbortSignal): Promise<unknown>;
  download?(fileId: string): Promise<Buffer>;
  call(method: string, params?: Json): Promise<unknown>;
}

export interface Keyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}
