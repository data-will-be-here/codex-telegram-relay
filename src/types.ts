export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
export type MessageMode = 'all' | 'compact';

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

export interface Codex {
  list(): Promise<Session[]>;
  attach(threadId: string): Promise<Json>;
  read(threadId: string): Promise<Json>;
  turns(threadId: string): Promise<Json[]>;
  start(threadId: string, text: string): Promise<unknown>;
  steer(threadId: string, turnId: string, text: string): Promise<unknown>;
  respond(id: string | number, result: Json): Promise<void>;
  hasRequest(id: string | number): boolean;
}

export interface Telegram {
  call(method: string, params?: Json): Promise<unknown>;
}

export interface Keyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}
