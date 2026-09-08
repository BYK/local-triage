const CACHE_NAME = "local-triage-event-model-v1";

function joinUrl(baseUrl, kind, key) {
  return `${baseUrl}${kind}/${encodeURIComponent(key)}`;
}

/**
 * Wllama's default OPFS backend creates a second blob worker to obtain a sync
 * access handle. Thunderbird can terminate that worker without an Error
 * object. Cache Storage is available directly to extension pages and accepts
 * streaming Response bodies, so it avoids both the worker and a 491 MB
 * in-memory copy while retaining the same StorageBackend interface.
 */
export class ExtensionModelCache {
  constructor(
    baseUrl = "https://local-triage.invalid/event-model-cache/",
    onDiagnostic = () => undefined,
  ) {
    this.baseUrl = baseUrl;
    this.dataPrefix = `${baseUrl}data/`;
    this.sizePrefix = `${baseUrl}size/`;
    this.onDiagnostic = onDiagnostic;
  }

  isSupported() {
    return Boolean(
      globalThis.caches?.open &&
      globalThis.Response &&
      globalThis.TransformStream,
    );
  }

  async getCache() {
    return caches.open(CACHE_NAME);
  }

  async read(key) {
    const response = await (await this.getCache()).match(
      joinUrl(this.baseUrl, "data", key),
    );
    if (!response) {
      this.onDiagnostic("cache.read.miss", key);
      return null;
    }
    const blob = await response.blob();
    this.onDiagnostic("cache.read.hit", `${key} (${blob.size} bytes)`);
    return blob;
  }

  async write(key, stream) {
    const cache = await this.getCache();
    const dataUrl = joinUrl(this.baseUrl, "data", key);
    const sizeUrl = joinUrl(this.baseUrl, "size", key);
    let size = 0;
    let reportedBytes = 0;
    const reportDiagnostic = this.onDiagnostic;
    this.onDiagnostic("cache.write.start", key);
    const countedStream = stream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size - reportedBytes >= 64 * 1024 * 1024) {
          reportedBytes = size;
          reportDiagnostic("cache.write.progress", `${size} bytes`);
        }
        controller.enqueue(chunk);
      },
    }));
    await cache.delete(sizeUrl);
    try {
      await cache.put(dataUrl, new Response(countedStream, {
        headers: { "Content-Type": "application/octet-stream" },
      }));
      await cache.put(sizeUrl, new Response(String(size), {
        headers: { "Content-Type": "text/plain" },
      }));
      this.onDiagnostic("cache.write.complete", `${key} (${size} bytes)`);
    } catch (error) {
      this.onDiagnostic("cache.write.error", error);
      await Promise.allSettled([cache.delete(dataUrl), cache.delete(sizeUrl)]);
      throw error;
    }
  }

  async getSize(key) {
    const cache = await this.getCache();
    const sizeUrl = joinUrl(this.baseUrl, "size", key);
    const sizeResponse = await cache.match(sizeUrl);
    if (sizeResponse) {
      const size = Number(await sizeResponse.text());
      if (Number.isFinite(size) && size >= 0) return size;
    }
    const dataResponse = await cache.match(joinUrl(this.baseUrl, "data", key));
    if (!dataResponse) return -1;
    const size = (await dataResponse.blob()).size;
    await cache.put(sizeUrl, new Response(String(size)));
    return size;
  }

  async list() {
    const cache = await this.getCache();
    const requests = await cache.keys();
    const keys = requests
      .map(({ url }) => url)
      .filter((url) => url.startsWith(this.dataPrefix))
      .map((url) => decodeURIComponent(url.slice(this.dataPrefix.length)));
    const result = await Promise.all(keys.map(async (key) => ({
      key,
      size: await this.getSize(key),
    })));
    this.onDiagnostic("cache.list", `${result.length} entries`);
    return result;
  }

  async delete(key) {
    const cache = await this.getCache();
    await Promise.all([
      cache.delete(joinUrl(this.baseUrl, "data", key)),
      cache.delete(joinUrl(this.baseUrl, "size", key)),
    ]);
  }
}
