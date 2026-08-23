export { clsx as cn } from 'clsx';

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/** binary units with pg_size_pretty's labels, so "8192 B" here matches what psql prints */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const unit = UNITS[i] ?? 'B';
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${unit}`;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** planner estimate, never a COUNT(*). reltuples = -1 means "never analyzed". */
export function rowsEstimate(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '? rows';
  return `~${compact.format(n)} rows`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return '…';
  const head = Math.ceil((n - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - 1 - head))}`;
}
