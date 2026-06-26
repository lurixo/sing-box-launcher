// Byte / speed / duration formatting shared by the dashboard and connections.

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${UNITS[i]}`;
}

export function formatSpeed(n: number): string {
  return `${formatBytes(n)}/s`;
}

/** Normalise a timestamp of unknown unit (s / ms / µs / ns) to milliseconds. */
export function normalizeMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  if (ts >= 1e16) return Math.floor(ts / 1e6); // nanoseconds
  if (ts >= 1e13) return Math.floor(ts / 1e3); // microseconds
  if (ts >= 1e11) return ts;                   // milliseconds
  return ts * 1e3;                             // seconds
}

/** Human duration since a unix-ms timestamp (e.g. "1h2m", "3m4s", "5s"). */
export function formatDuration(startMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}
