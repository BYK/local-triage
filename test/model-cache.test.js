import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionModelCache } from "../src/model-cache.js";

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async match(url) {
    return this.entries.get(String(url))?.clone();
  }

  async put(url, response) {
    this.entries.set(String(url), response.clone());
    await response.arrayBuffer();
  }

  async delete(url) {
    return this.entries.delete(String(url));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

test("the extension model cache streams, lists, and removes model data", async () => {
  const originalCaches = globalThis.caches;
  const memoryCache = new MemoryCache();
  globalThis.caches = { open: async () => memoryCache };
  try {
    const backend = new ExtensionModelCache("https://extension.invalid/model-cache/");
    assert.equal(backend.isSupported(), true);
    const bytes = new TextEncoder().encode("gguf-test-data");
    await backend.write("model.gguf", new Blob([bytes]).stream());
    assert.equal(await backend.getSize("model.gguf"), bytes.byteLength);
    assert.equal(await (await backend.read("model.gguf")).text(), "gguf-test-data");
    assert.deepEqual(await backend.list(), [
      { key: "model.gguf", size: bytes.byteLength },
    ]);
    await backend.delete("model.gguf");
    assert.equal(await backend.read("model.gguf"), null);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
