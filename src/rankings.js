const MAX_RANKINGS = 5000;

export function messageKey(header) {
  const accountId = header.folder?.accountId ?? "external";
  return `${accountId}:${header.headerMessageId || header.id}`;
}

export async function storeRanking(header, result) {
  const stored = await messenger.storage.local.get("rankings");
  const rankings = stored.rankings ?? {};
  rankings[messageKey(header)] = {
    baseScore: result.score,
    category: result.category.name,
    priority: result.priority.key,
    confidence: result.categoryConfidence,
    engine: result.engine,
    receivedAt: new Date(header.date).toISOString(),
    unread: !header.read,
    updatedAt: new Date().toISOString(),
  };

  const entries = Object.entries(rankings);
  if (entries.length > MAX_RANKINGS) {
    entries
      .sort(
        (left, right) =>
          new Date(left[1].updatedAt).getTime() - new Date(right[1].updatedAt).getTime(),
      )
      .slice(0, entries.length - MAX_RANKINGS)
      .forEach(([key]) => delete rankings[key]);
  }
  await messenger.storage.local.set({ rankings });
}

