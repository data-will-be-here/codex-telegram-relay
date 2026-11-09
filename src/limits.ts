import { integer, object, type Json } from './types.js';

function label(value: unknown): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return [...clean].slice(0, 100).join('').replace(/[\\`*_\[\]<>|]/gu, '\\$&');
}

function remaining(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? 'remaining ' + new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value) + '%'
    : 'remaining quota unavailable';
}

function windowName(minutes: unknown, index: number): string {
  if (minutes === 10080) return 'Weekly limit';
  if (minutes === 1440) return 'Daily limit';
  const duration = integer(minutes);
  if (duration !== undefined && duration > 0) {
    const unit = duration % 1440 === 0 ? `${duration / 1440} d` : duration % 60 === 0 ? `${duration / 60} h` : `${duration} min`;
    return `Limit for ${unit}`;
  }
  return index === 0 ? 'Primary limit' : 'Secondary limit';
}

function resetLines(value: unknown, now: number, dates: Intl.DateTimeFormat): string[] {
  const seconds = integer(value);
  const timestamp = seconds === undefined || seconds < 0 ? NaN : seconds * 1000;
  if (!Number.isFinite(new Date(timestamp).getTime())) return ['Reset: time unavailable'];
  const lines = [`Reset: ${dates.format(timestamp)}`];
  if (timestamp <= now) return [...lines, 'The reset time has passed; quota recovery is not yet confirmed.'];
  const minutes = Math.ceil((timestamp - now) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  const parts = [days ? `${days} d` : '', hours ? `${hours} h` : '', rest ? `${rest} min` : ''].filter(Boolean);
  return [...lines, 'In ' + parts.join(' ')];
}

/** A fresh account snapshot, with explicitly labelled host timezone and no inferred recovery. */
export function formatLimits(snapshot: Json, now = Date.now(), timeZone?: string): string {
  const dates = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  });
  const lines = ['Codex account limits'];
  if (snapshot.ordinaryUsageAllowed === false) lines.push('Included usage is currently restricted according to Codex.');
  const entries = Object.entries(object(snapshot.rateLimitsByLimitId))
    .filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value));
  const groups = entries.slice(0, 100).map(([id, value]) => [id, object(value)] as const);
  const legacy = object(snapshot.rateLimits);
  if (!groups.length && Object.keys(legacy).length) groups.push(['', legacy]);
  for (const [id, bucket] of groups) {
    lines.push('', label(bucket.limitName) || label(bucket.limitId) || label(id) || 'Codex');
    if (label(bucket.planType)) lines.push('Plan: ' + label(bucket.planType));
    if (bucket.spendControlReached === true) lines.push('Spending limit reached.');
    const reached = bucket.rateLimitReachedType;
    if (reached === 'rate_limit_reached') lines.push('Usage limit reached.');
    if (reached === 'workspace_owner_credits_depleted' || reached === 'workspace_member_credits_depleted') lines.push('Codex reports that workspace credits are depleted.');
    if (reached === 'workspace_owner_usage_limit_reached' || reached === 'workspace_member_usage_limit_reached') lines.push('Workspace usage limit reached.');
    let count = 0;
    for (const [index, value] of [bucket.primary, bucket.secondary].entries()) {
      if (value === null || value === undefined) continue;
      const window = object(value);
      const used = typeof window.usedPercent === 'number' ? window.usedPercent : NaN;
      lines.push('', `${windowName(window.windowDurationMins, index)}: ${remaining(100 - used)}`,
        ...resetLines(window.resetsAt, now, dates));
      count++;
    }
    if (!count) lines.push('Usage-window data unavailable.');
    if (bucket.credits !== null && bucket.credits !== undefined) {
      const credits = object(bucket.credits);
      const balance = label(credits.balance);
      lines.push('', 'Credits: ' + (credits.unlimited === true ? 'unlimited' : balance ||
        (credits.hasCredits === false ? 'none' : credits.hasCredits === true ? 'available, balance not provided' : 'data unavailable')));
    }
    if (bucket.individualLimit !== null && bucket.individualLimit !== undefined) {
      const spending = object(bucket.individualLimit);
      lines.push('', `Spending limit: ${remaining(spending.remainingPercent)}`);
      if (label(spending.used) && label(spending.limit)) lines.push(`Used: ${label(spending.used)} of ${label(spending.limit)}`);
      lines.push(...resetLines(spending.resetsAt, now, dates));
    }
  }
  if (!groups.length) lines.push('', 'Quota data unavailable.');
  let body = lines.join('\n');
  const shortened = body.length > 28_000 || entries.length > groups.length;
  if (body.length > 28_000) body = body.slice(0, body.lastIndexOf('\n', 28_000));
  return body + (shortened ? '\n\nThe limits list was shortened to fit this response.' : '') + `\n\nChecked: ${dates.format(now)}`;
}
