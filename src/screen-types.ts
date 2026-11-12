/** Presentation only. Native action authority stays in the existing command/prompt handlers. */
export interface ScreenOptions {
  title: string;
  kind: 'approval' | 'question' | 'menu' | 'info' | 'text';
  editable?: boolean;
  markdown?: boolean;
  fullText?: string | undefined;
  caption?: string | undefined;
  meters?: { label: string; remaining: number }[] | undefined;
  widgets?: boolean | undefined;
}
export interface ScreenSpec extends ScreenOptions { token: string; }
