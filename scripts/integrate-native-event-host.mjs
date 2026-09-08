import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const host = path.join(root, "native", "directml-host", "host.cjs");
const cache = process.env.LOCAL_TRIAGE_MODEL_CACHE ||
  path.join(root, "native-integration-model-cache");
const maximumWarmGenerationMs = Number(
  process.env.LOCAL_TRIAGE_MAX_WARM_GENERATION_MS ?? 10_000,
);
const child = spawn(process.execPath, [host], {
  env: {
    ...process.env,
    LOCAL_TRIAGE_FORCE_CPU: "1",
    LOCAL_TRIAGE_MODEL_CACHE: cache,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let incoming = Buffer.alloc(0);
let requestId = 0;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4) {
    const length = incoming.readUInt32LE(0);
    if (incoming.length < length + 4) return;
    const body = JSON.parse(incoming.subarray(4, length + 4).toString("utf8"));
    incoming = incoming.subarray(length + 4);
    if (body.type === "progress") {
      process.stderr.write(`[integration.${body.phase}] ${body.detail ?? ""}\n`);
      continue;
    }
    const waiter = pending.get(body.id);
    if (!waiter) continue;
    pending.delete(body.id);
    if (body.ok) waiter.resolve(body.result);
    else waiter.reject(new Error(body.error));
  }
});

function request(method, payload = {}) {
  const id = ++requestId;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  const body = Buffer.from(JSON.stringify({ id, method, payload }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
  return promise;
}

function cosine(left, right) {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftLength += left[index] ** 2;
    rightLength += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength));
}

try {
  const embeddingPrepared = await request("prepare-embedding", {
    modelId: "Xenova/multilingual-e5-small",
    dtype: "q8",
  });
  assert.equal(embeddingPrepared.engine, "multilingual-e5");
  assert.equal(embeddingPrepared.device, "cpu");
  const embeddingStartedAt = Date.now();
  const embedding = await request("embed", {
    modelId: "Xenova/multilingual-e5-small",
    dtype: "q8",
    maxLength: 64,
    texts: [
      "query: finance and investment planning",
      "passage: yatırım fonu ve emeklilik planlaması",
      "passage: weekend travel promotions",
    ],
  });
  const embeddingElapsedMs = Date.now() - embeddingStartedAt;
  assert.equal(embedding.vectors.length, 3);
  assert.equal(embedding.vectors[0].length, 384);
  assert.ok(embedding.vectors.flat().every(Number.isFinite));
  assert.ok(
    cosine(embedding.vectors[0], embedding.vectors[1]) >
      cosine(embedding.vectors[0], embedding.vectors[2]),
    "The bilingual finance pair should be more similar than the travel passage.",
  );

  const preparing = request("prepare");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const liveDiagnostics = await Promise.race([
    request("diagnostics"),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Supervisor diagnostics blocked during model preparation")),
      2_000,
    )),
  ]);
  assert.equal(liveDiagnostics.hostVersion, "0.13.9");
  assert.equal(liveDiagnostics.runtimeVersion, 30);
  assert.ok(["starting", "loading", "ready"].includes(liveDiagnostics.worker.state));

  const prepared = await preparing;
  assert.equal(prepared.modelId, "onnx-community/Qwen3.5-0.8B-ONNX");
  assert.equal(prepared.dtype, "q4");

  const input = {
    _diagnosticSafe: true,
    date: "2026-09-06T08:00:00Z",
    subject: "Invitation 48291",
    body: [
      "Please join us for the quarterly engineering planning workshop.",
      "The agenda covers staffing, release risks, and next-quarter owners.",
      "Kind regards, Automated Events Team",
    ].join("\n"),
    detectedEvent: {
      startDate: "2026-09-10",
      startTime: "14:00",
      endDate: "2026-09-10",
      endTime: "16:00",
      durationMinutes: 120,
      location: "The Shard, Level 12",
    },
  };
  const englishStartedAt = Date.now();
  const generated = await request("generate", input);
  const englishElapsedMs = Date.now() - englishStartedAt;
  assert.ok(generated.title.length >= 4 && generated.title.length <= 100);
  assert.ok(generated.description.length >= 8 && generated.description.length <= 700);
  assert.equal("startDate" in generated, false);
  assert.equal("location" in generated, false);
  assert.doesNotMatch(generated.description, /kind regards|automated events team/i);
  assert.ok(
    englishElapsedMs <= maximumWarmGenerationMs,
    `English generation took ${englishElapsedMs}ms; limit is ${maximumWarmGenerationMs}ms.`,
  );

  const turkishStartedAt = Date.now();
  const turkish = await request("generate", {
    _diagnosticSafe: true,
    date: "2026-09-06T08:00:00Z",
    subject: "Yatırımcı buluşması hatırlatması",
    body: "Fonun yeni yatırım stratejisini ve yıl sonu hedeflerini görüşmek üzere yatırımcılarımızı bekliyoruz. Saygılar.",
    detectedEvent: {
      startDate: "2026-09-18",
      startTime: "10:00",
      endDate: "2026-09-18",
      endTime: "11:30",
      durationMinutes: 90,
      location: "Yapı Kredi Plaza, D Blok, Kat 8, Levent / İstanbul",
    },
  });
  const turkishElapsedMs = Date.now() - turkishStartedAt;
  assert.ok(turkish.title.length >= 4 && turkish.title.length <= 100);
  assert.ok(turkish.description.length >= 8 && turkish.description.length <= 700);
  assert.match(`${turkish.title} ${turkish.description}`, /[çğıöşüÇĞİÖŞÜ]|\b(?:ve|için|yatırım|strateji|hedef)\b/i);
  assert.equal("startDate" in turkish, false);
  assert.equal("location" in turkish, false);
  assert.ok(
    turkishElapsedMs <= maximumWarmGenerationMs,
    `Turkish generation took ${turkishElapsedMs}ms; limit is ${maximumWarmGenerationMs}ms.`,
  );
  process.stdout.write(`${JSON.stringify({
    embedding: {
      prepared: embeddingPrepared,
      elapsedMs: embeddingElapsedMs,
      dimensions: embedding.vectors[0].length,
      bilingualFinanceSimilarity: cosine(embedding.vectors[0], embedding.vectors[1]),
      travelSimilarity: cosine(embedding.vectors[0], embedding.vectors[2]),
    },
    prepared,
    performance: { maximumWarmGenerationMs, englishElapsedMs, turkishElapsedMs },
    english: generated,
    turkish,
  }, null, 2)}\n`);
} finally {
  child.stdin.end();
}
