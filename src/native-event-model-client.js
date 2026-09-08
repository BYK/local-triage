import { updateMonotonicDownloadPercent } from "./progress.js";
import { withTimeout } from "./timeout.js";

export const NATIVE_EVENT_HOST = "im.byk.local_triage";
export const NATIVE_EVENT_MODEL_ID = "onnx-community/Qwen3.5-0.8B-ONNX";
export const NATIVE_EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
export const NATIVE_EVENT_HOST_VERSION = "0.13.9";
const EVENT_MODEL_RUNTIME_VERSION = 30;

const CONNECT_TIMEOUT_MS = 8 * 1000;
const PREPARE_TIMEOUT_MS = 20 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 60 * 1000;
const EMBEDDING_PREPARE_TIMEOUT_MS = 8 * 60 * 1000;
const EMBEDDING_REQUEST_TIMEOUT_MS = 90 * 1000;

let port;
let connectionPromise;
let eventReady = false;
let eventPreparationPromise;
let embeddingReady = false;
let embeddingPreparationPromise;
let embeddingSignature;
let nextRequestId = 1;
let lastDiagnostics;
let unavailableUntil = 0;
let lastConnectionError;
let lastDiagnosticError;
let lastHandshake;
let lastNativeDownloadPercent;
let lastNativeVariantKey;
const pending = new Map();

function nativeError(message, cause, code = "NATIVE_EVENT_HOST_UNAVAILABLE") {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function storeCompanionStatus(status) {
  await messenger.storage.local.set({
    nativeEventModelStatus: {
      ...status,
      host: NATIVE_EVENT_HOST,
      modelId: NATIVE_EVENT_MODEL_ID,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function publishProgress(message) {
  const variantKey = message.variant?.key;
  if (variantKey && variantKey !== lastNativeVariantKey) {
    lastNativeVariantKey = variantKey;
    lastNativeDownloadPercent = undefined;
  }
  lastNativeDownloadPercent = updateMonotonicDownloadPercent(
    lastNativeDownloadPercent,
    message,
  );
  const percent = Number.isFinite(lastNativeDownloadPercent)
    ? Math.round(lastNativeDownloadPercent)
    : undefined;
  const phase = message.phase ?? "loading";
  const embedding = message.variant?.kind === "embedding" ||
    phase.startsWith("embedding-");
  const detail = phase === "native-download" && Number.isFinite(percent)
    ? `Downloading Qwen3.5: ${percent}%`
    : message.detail ?? "Preparing the native CPU event model…";
  const state = phase === "ready" || phase === "embedding-ready"
    ? "ready"
    : "loading";
  const device = message.device ?? "cpu";
  const dtype = message.dtype ?? "q4";
  if (embedding) {
    await messenger.storage.local.set({
      modelStatus: {
        state,
        phase,
        detail,
        percent,
        file: message.file,
        modelId: message.modelId ?? NATIVE_EMBEDDING_MODEL_ID,
        runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
        device,
        dtype,
        backend: "native",
        updatedAt: new Date().toISOString(),
      },
    });
    return;
  }
  await Promise.all([
    storeCompanionStatus({
      state,
      phase,
      detail,
      percent,
      device,
      dtype,
      backend: "native",
    }),
    messenger.storage.local.set({
      eventModelStatus: {
        state,
        phase,
        detail,
        percent,
        modelId: NATIVE_EVENT_MODEL_ID,
        activeModelId: NATIVE_EVENT_MODEL_ID,
        runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
        device,
        dtype,
        backend: "native",
        updatedAt: new Date().toISOString(),
      },
    }),
  ]);
}

function rejectAll(error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function attachPort(nativePort) {
  port = nativePort;
  nativePort.onMessage.addListener((message) => {
    if (message?.type === "progress") {
      publishProgress(message).catch(console.error);
      return;
    }
    if (message?.type === "diagnostic") {
      lastDiagnostics = message.diagnostics;
      messenger.storage.local.set({
        eventModelDiagnostics: {
          activeBackend: "native",
          nativeCompanion: lastDiagnostics,
        },
      }).catch(console.error);
      return;
    }
    if (message?.type !== "response") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else {
      lastDiagnostics = message.diagnostics ?? lastDiagnostics;
      const error = message.error ?? "The native Windows companion request failed.";
      const embedding = request.method === "prepare-embedding" ||
        request.method === "embed";
      const status = {
        state: "error",
        phase: "request",
        error,
        detail: embedding
          ? "The native embedding model failed; heuristic classification remains available."
          : "The native CPU event model failed; deterministic event extraction remains available.",
        device: message.device ?? "cpu",
        dtype: message.dtype ?? (embedding ? "q8" : "q4"),
        backend: "native",
        updatedAt: new Date().toISOString(),
      };
      (embedding
        ? messenger.storage.local.set({
            modelStatus: {
              ...status,
              modelId: NATIVE_EMBEDDING_MODEL_ID,
              runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
            },
          })
        : storeCompanionStatus(status)).catch(console.error);
      request.reject(nativeError(error));
    }
  });
  nativePort.onDisconnect.addListener(() => {
    if (port !== nativePort) return;
    const detail = messenger.runtime.lastError?.message ||
      "The native Windows companion disconnected.";
    port = undefined;
    connectionPromise = undefined;
    eventReady = false;
    eventPreparationPromise = undefined;
    embeddingReady = false;
    embeddingPreparationPromise = undefined;
    rejectAll(nativeError(detail));
    storeCompanionStatus({
      state: "unavailable",
      phase: "disconnected",
      error: detail,
      detail: "Native Windows companion unavailable; deterministic event extraction remains available.",
      device: "cpu",
      dtype: "q4",
      backend: "native",
    }).catch(console.error);
  });
}

function postRequest(method, payload, timeoutMs) {
  if (!port) {
    return Promise.reject(nativeError("The native Windows companion is not connected."));
  }
  const id = nextRequestId++;
  const response = new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
  try {
    port.postMessage({ id, method, payload });
  } catch (error) {
    pending.delete(id);
    return Promise.reject(nativeError(
      `Could not send a request to the native Windows companion: ${error?.message ?? error}`,
      error,
    ));
  }
  return withTimeout(
    response,
    timeoutMs,
    `The native Windows companion timed out during ${method}`,
  ).finally(() => pending.delete(id));
}

async function connect() {
  // attachPort() runs before the ping handshake finishes. Every concurrent
  // caller must await that same handshake instead of treating the mere
  // existence of a port as proof that the companion is compatible.
  if (connectionPromise) return connectionPromise;
  if (port && lastHandshake) return port;
  if (Date.now() < unavailableUntil && lastConnectionError) {
    throw nativeError(lastConnectionError);
  }
  if (!messenger.runtime.connectNative) {
    throw nativeError("This Thunderbird build does not expose native messaging.");
  }
  if (!connectionPromise) {
    connectionPromise = (async () => {
      let nativePort;
      try {
        nativePort = messenger.runtime.connectNative(NATIVE_EVENT_HOST);
        attachPort(nativePort);
      } catch (error) {
        throw nativeError(
          `Could not start the native Windows companion: ${error?.message ?? error}`,
          error,
        );
      }
      const handshake = await withTimeout(
        postRequest("ping", {}, CONNECT_TIMEOUT_MS),
        CONNECT_TIMEOUT_MS,
        "The native Windows companion did not answer within eight seconds",
      );
      lastHandshake = handshake;
      if (
        handshake?.hostVersion !== NATIVE_EVENT_HOST_VERSION ||
        handshake?.runtimeVersion !== EVENT_MODEL_RUNTIME_VERSION ||
        handshake?.modelId !== NATIVE_EVENT_MODEL_ID ||
        handshake?.embeddingModelId !== NATIVE_EMBEDDING_MODEL_ID
      ) {
        const error = nativeError(
          `Installed companion ${handshake?.hostVersion ?? "unknown"} ` +
          `(runtime ${handshake?.runtimeVersion ?? "unknown"}, ` +
          `${handshake?.modelId ?? "unknown event model"}, ` +
          `${handshake?.embeddingModelId ?? "unknown embedding model"}) is incompatible. ` +
          `Install companion ${NATIVE_EVENT_HOST_VERSION} and restart Thunderbird.`,
          undefined,
          "NATIVE_EVENT_HOST_INCOMPATIBLE",
        );
        // Do not let a persisted report from the previous helper make a
        // rejected companion look as though it is still preparing a model.
        lastDiagnostics = {
          generatedAt: new Date().toISOString(),
          hostVersion: handshake?.hostVersion,
          runtimeVersion: handshake?.runtimeVersion,
          modelId: handshake?.modelId,
          embeddingModelId: handshake?.embeddingModelId,
          state: "incompatible",
          lastGenerationState: "idle",
          error: error.message,
          environment: {},
          entries: [],
        };
        throw error;
      }
      unavailableUntil = 0;
      lastConnectionError = undefined;
      lastDiagnosticError = undefined;
      await storeCompanionStatus({
        state: "connected",
        phase: "connected",
        detail: `Native companion ${handshake.hostVersion} connected; model not prepared yet.`,
        hostVersion: handshake.hostVersion,
        runtimeVersion: handshake.runtimeVersion,
        device: "cpu",
        dtype: "q4",
        backend: "native",
      });
      return nativePort;
    })().catch(async (error) => {
      connectionPromise = undefined;
      lastConnectionError = String(error?.message ?? error);
      unavailableUntil = Date.now() + 60 * 1000;
      if (port) {
        port.disconnect();
        port = undefined;
      }
      await storeCompanionStatus({
        state: "unavailable",
        phase: "connect",
        error: lastConnectionError,
        detail: "Install or repair the Local Triage Windows companion to enable native inference.",
        device: "cpu",
        dtype: "q4",
        backend: "native",
      });
      if (lastDiagnostics) {
        await messenger.storage.local.set({
          eventModelDiagnostics: {
            generatedAt: new Date().toISOString(),
            activeBackend: "native",
            nativeCompanion: lastDiagnostics,
          },
        });
      }
      throw error;
    });
  }
  return connectionPromise;
}

async function request(method, payload, timeoutMs) {
  await connect();
  return postRequest(method, payload, timeoutMs);
}

export async function prepareNativeEventModel() {
  if (eventReady && eventPreparationPromise) return eventPreparationPromise;
  if (!eventPreparationPromise) {
    eventPreparationPromise = request("prepare", {}, PREPARE_TIMEOUT_MS)
      .then(async (result) => {
        eventReady = true;
        await storeCompanionStatus({
          state: "ready",
          phase: "ready",
          detail: `Native Qwen3.5 event model ready on ${result.device}.`,
          percent: 100,
          device: result.device,
          dtype: result.dtype,
          backend: "native",
          engine: result.engine,
        });
        return result;
      })
      .catch((error) => {
        eventPreparationPromise = undefined;
        eventReady = false;
        throw error;
      });
  }
  return eventPreparationPromise;
}

export async function generateNativeEventDetails(input) {
  if (!eventReady) await prepareNativeEventModel();
  const result = await request("generate", input, GENERATE_TIMEOUT_MS);
  eventReady = true;
  await Promise.all([
    storeCompanionStatus({
      state: "ready",
      phase: "ready",
      detail: `Native Qwen3.5 event model ready on ${result._device}.`,
      percent: 100,
      device: result._device,
      dtype: result._dtype,
      backend: "native",
      engine: result._engine,
    }),
    messenger.storage.local.set({
      eventModelStatus: {
        state: "ready",
        phase: "ready",
        percent: 100,
        modelId: NATIVE_EVENT_MODEL_ID,
        activeModelId: NATIVE_EVENT_MODEL_ID,
        runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
        device: result._device,
        dtype: result._dtype,
        backend: "native",
        updatedAt: new Date().toISOString(),
      },
    }),
  ]);
  return result;
}

export async function prepareNativeEmbeddingModel({
  modelId = NATIVE_EMBEDDING_MODEL_ID,
  dtype = "q8",
} = {}) {
  const signature = `${modelId}:${dtype}`;
  if (embeddingReady && embeddingSignature === signature && embeddingPreparationPromise) {
    return embeddingPreparationPromise;
  }
  if (!embeddingPreparationPromise || embeddingSignature !== signature) {
    embeddingSignature = signature;
    embeddingReady = false;
    embeddingPreparationPromise = request(
      "prepare-embedding",
      { modelId, dtype },
      EMBEDDING_PREPARE_TIMEOUT_MS,
    ).then(async (result) => {
      embeddingReady = true;
      await messenger.storage.local.set({
        modelStatus: {
          state: "ready",
          phase: "embedding-ready",
          detail: `Multilingual embedding model ready on native ${result.device}.`,
          percent: 100,
          modelId,
          runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
          device: result.device,
          dtype: result.dtype,
          backend: "native",
          updatedAt: new Date().toISOString(),
        },
      });
      return result;
    }).catch((error) => {
      embeddingPreparationPromise = undefined;
      embeddingReady = false;
      throw error;
    });
  }
  return embeddingPreparationPromise;
}

export async function embedNativeTexts(texts, {
  modelId = NATIVE_EMBEDDING_MODEL_ID,
  dtype = "q8",
  maxLength = 256,
} = {}) {
  await prepareNativeEmbeddingModel({ modelId, dtype });
  const values = Array.isArray(texts) ? texts : [texts];
  const vectors = [];
  let metadata;
  for (let index = 0; index < values.length; index += 32) {
    const result = await request(
      "embed",
      {
        texts: values.slice(index, index + 32),
        modelId,
        dtype,
        maxLength,
      },
      EMBEDDING_REQUEST_TIMEOUT_MS,
    );
    vectors.push(...result.vectors);
    metadata = result;
  }
  return { ...metadata, vectors };
}

export async function getNativeEventModelDiagnostics() {
  try {
    lastDiagnostics = await request("diagnostics", {}, CONNECT_TIMEOUT_MS);
    lastDiagnosticError = undefined;
  } catch (error) {
    // The last in-memory report is still useful if the process just exited or
    // an older companion is blocking inside model initialization.
    lastDiagnosticError = String(error?.message ?? error);
  }
  if (lastDiagnostics) {
    return {
      ...lastDiagnostics,
      error: lastDiagnosticError ?? lastConnectionError ?? lastDiagnostics.error,
    };
  }
  if (!lastDiagnosticError && !lastConnectionError && !lastHandshake) return undefined;
  return {
    generatedAt: new Date().toISOString(),
    hostVersion: lastHandshake?.hostVersion,
    runtimeVersion: lastHandshake?.runtimeVersion,
    modelId: lastHandshake?.modelId ?? NATIVE_EVENT_MODEL_ID,
    state: isNativeEventModelBusy() ? "loading" : "unavailable",
    error: lastDiagnosticError ?? lastConnectionError,
    environment: {},
    entries: [],
  };
}

export async function clearNativeEventModelDiagnostics() {
  lastDiagnostics = undefined;
  try {
    return await request("clear-diagnostics", {}, CONNECT_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

export function isNativeEventModelReady() {
  return eventReady;
}

export function isNativeEventModelBusy() {
  return pending.size > 0 || Boolean(connectionPromise && !port);
}
