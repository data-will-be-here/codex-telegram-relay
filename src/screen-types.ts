/** Presentation only. Native action authority stays in the existing command/prompt handlers. */
export interface ScreenOptions {
  title: string;
  kind: 'approval' | 'question' | 'menu' | 'info' | 'text';
  editable?: boolean;
  markdown?: boolean;
  fullText?: string | undefined;
  /** One read-only disclosure entry instead of the usual text-copy button. */
  details?: boolean;
  caption?: string | undefined;
  meters?: { label: string; remaining: number }[] | undefined;
  widgets?: boolean | undefined;
}
export interface ScreenSpec extends ScreenOptions { token: string; }
