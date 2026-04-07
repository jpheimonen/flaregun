/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Examples:
 *   0-59s   → "5s"
 *   1-59m   → "3m 25s"
 *   1-23h   → "2h 15m"
 *   24h+    → "1d 4h"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Calculate uptime from a runningSince ISO timestamp to now.
 * Returns a human-readable duration string.
 */
export function formatUptime(runningSince: string): string {
  const start = new Date(runningSince).getTime();
  const now = Date.now();
  return formatDuration(now - start);
}
