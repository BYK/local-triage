export function updateMonotonicDownloadPercent(currentPercent, message = {}) {
  if (message.phase === "native-loading") return undefined;
  if (message.phase === "ready") return 100;
  if (!Number.isFinite(message.percent)) return currentPercent;

  const candidate = Math.min(100, Math.max(0, message.percent));
  return Number.isFinite(currentPercent)
    ? Math.max(currentPercent, candidate)
    : candidate;
}
