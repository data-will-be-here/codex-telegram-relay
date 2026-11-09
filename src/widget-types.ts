import { type Binding } from './types.js';

export type ViewMode = 'classic' | 'widgets';
export type ActivityStatus = 'working' | 'approval' | 'answer' | 'done' | 'interrupted' | 'failed' | 'disconnected' | 'unavailable';
export interface WidgetActivity { id: string; label: string; status: 'running' | 'done' | 'failed'; }
export interface WidgetSnapshot {
  status: ActivityStatus; startedAt: number | null; finishedAt: number | null; updatedAt: number;
  plan: { done: number; total: number; current?: string } | null; activities: WidgetActivity[];
}
export interface WidgetCard {
  id: string; token: string; generation: string; binding: Binding; turnId: string; view: ViewMode;
  revision: number; createdAt: number; snapshot: WidgetSnapshot;
}
export interface WidgetDelivery extends WidgetCard {
  delivery: 'new' | 'sending' | 'active' | 'editing' | 'uncertain' | 'disabled' | 'retired';
  messageId: number | null; sentRevision: number; retryAt: number; lastSentAt: number;
}
export interface WidgetDeliveryGuard { generation: string; allowed: (card: WidgetDelivery) => Promise<boolean>; }
