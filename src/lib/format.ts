/** 字节数与传输速率人类可读格式化工具 */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes < 0 || Number.isNaN(bytes)) {
    return "0 B";
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bytesPerSec: number | null | undefined): string {
  if (!bytesPerSec || bytesPerSec <= 0 || Number.isNaN(bytesPerSec)) {
    return "";
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

export function calcPercent(current: number, total: number, completed = false): number {
  if (completed) return 100;
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}
