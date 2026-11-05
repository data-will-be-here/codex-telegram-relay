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
  id: string;
  cwd: string;
  name: string;
  status: string;
  createdAt?: number;
  activeTurnId?: string;
}

export interface Binding {
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

export interface Codex {
  loaded?(): Promise<string[]>;
  asyncQuestions?(threadId: string, historySinceMs?: number, answeredCallIds?: readonly string[]): Promise<import('./async-questions.js').AsyncQuestion[]>;
  list(eligible?: (session: Session) => boolean): Promise<Session[]>;
  attach(threadId: string): Promise<Json>;
  read(threadId: string, timeoutMs?: number): Promise<Json>;
  turns(threadId: string): Promise<Json[]>;
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
