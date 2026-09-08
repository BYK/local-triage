export const EVENT_DETAILS_CACHE_STORAGE_KEY = "eventDetailsCache";
export const EVENT_DETAILS_CACHE_VERSION = 2;
export const EVENT_DETAILS_CACHE_LIMIT = 200;

function normalizedDate(value) {
  const timestamp = new Date(value ?? 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function eventCacheSignature(header) {
  return [
    String(header?.headerMessageId ?? `thunderbird:${header?.id ?? "unknown"}`),
    normalizedDate(header?.date),
    String(header?.subject ?? ""),
  ].join("\u0000");
}

function signatureHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `event-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function eventCacheKey(header) {
  return signatureHash(eventCacheSignature(header));
}

export function pruneEventDetailsCache(records, limit = EVENT_DETAILS_CACHE_LIMIT) {
  return Object.fromEntries(
    Object.entries(records ?? {})
      .sort(([, left], [, right]) =>
        String(right?.cachedAt ?? "").localeCompare(String(left?.cachedAt ?? "")))
      .slice(0, limit),
  );
}

export function createEventDetailsCache(storage, {
  modelId,
  runtimeVersion,
  limit = EVENT_DETAILS_CACHE_LIMIT,
} = {}) {
  let mutationQueue = Promise.resolve();

  async function get(header) {
    const stored = await storage.get(EVENT_DETAILS_CACHE_STORAGE_KEY);
    const records = stored?.[EVENT_DETAILS_CACHE_STORAGE_KEY] ?? {};
    const record = records[eventCacheKey(header)];
    if (
      record?.cacheVersion !== EVENT_DETAILS_CACHE_VERSION ||
      record?.modelId !== modelId ||
      record?.runtimeVersion !== runtimeVersion ||
      record?.signature !== eventCacheSignature(header) ||
      !record?.event
    ) {
      return undefined;
    }
    return { ...record.event, enrichmentCache: "hit" };
  }

  function set(header, event) {
    const operation = mutationQueue.then(async () => {
      const stored = await storage.get(EVENT_DETAILS_CACHE_STORAGE_KEY);
      const records = stored?.[EVENT_DETAILS_CACHE_STORAGE_KEY] ?? {};
      records[eventCacheKey(header)] = {
        cacheVersion: EVENT_DETAILS_CACHE_VERSION,
        modelId,
        runtimeVersion,
        signature: eventCacheSignature(header),
        cachedAt: new Date().toISOString(),
        event: { ...event, enrichmentCache: "stored" },
      };
      await storage.set({
        [EVENT_DETAILS_CACHE_STORAGE_KEY]: pruneEventDetailsCache(records, limit),
      });
    });
    mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  return { get, set, key: eventCacheKey };
}
