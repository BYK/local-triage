import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventDetailsCache,
  EVENT_DETAILS_CACHE_STORAGE_KEY,
  eventCacheKey,
  eventCacheSignature,
} from "../src/event-cache.js";

function memoryStorage() {
  const values = {};
  return {
    values,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(changes) {
      Object.assign(values, structuredClone(changes));
    },
  };
}

const header = {
  id: 42,
  headerMessageId: "meetup-210@example.test",
  subject: "JSMonthly London September Meetup #210",
  date: "2026-09-08T10:59:18Z",
};

test("event details persist and return as a cache hit", async () => {
  const storage = memoryStorage();
  const cache = createEventDetailsCache(storage, {
    modelId: "qwen-test",
    runtimeVersion: 30,
  });
  await cache.set(header, {
    detected: true,
    title: "JS Monthly London Meetup",
    location: "NewDay, 7 Handyside Street, London N1C 4DC",
  });

  const cached = await cache.get({ ...header, id: 99 });
  assert.equal(cached.title, "JS Monthly London Meetup");
  assert.equal(cached.enrichmentCache, "hit");
  assert.ok(storage.values[EVENT_DETAILS_CACHE_STORAGE_KEY][eventCacheKey(header)]);
});

test("event cache invalidates on message or model changes", async () => {
  const storage = memoryStorage();
  const cache = createEventDetailsCache(storage, {
    modelId: "qwen-test",
    runtimeVersion: 30,
  });
  await cache.set(header, { detected: true, title: "Meetup" });

  assert.equal(await cache.get({ ...header, subject: "Changed" }), undefined);
  assert.equal(
    await createEventDetailsCache(storage, {
      modelId: "new-model",
      runtimeVersion: 30,
    }).get(header),
    undefined,
  );
  assert.notEqual(
    eventCacheSignature(header),
    eventCacheSignature({ ...header, date: "2026-09-09T10:59:18Z" }),
  );
});

test("event cache is bounded", async () => {
  const storage = memoryStorage();
  const cache = createEventDetailsCache(storage, {
    modelId: "qwen-test",
    runtimeVersion: 30,
    limit: 2,
  });
  await cache.set({ ...header, headerMessageId: "one" }, { title: "One" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await cache.set({ ...header, headerMessageId: "two" }, { title: "Two" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await cache.set({ ...header, headerMessageId: "three" }, { title: "Three" });

  assert.equal(
    Object.keys(storage.values[EVENT_DETAILS_CACHE_STORAGE_KEY]).length,
    2,
  );
  assert.equal(await cache.get({ ...header, headerMessageId: "one" }), undefined);
});
