import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  categoriesFromText,
  categoriesToText,
  getSettings,
  normalizeSettings,
  saveSettings,
} from "./settings.js";
import { withTimeout } from "./timeout.js";

const form = document.querySelector("#settings-form");
const notice = document.querySelector("#notice");
const testResult = document.querySelector("#test-result");
const embeddingModelProgress = document.querySelector("#embedding-model-progress");
const eventModelButton = document.querySelector("#event-model-self-test");
const eventModelResult = document.querySelector("#event-model-result");
const eventModelProgress = document.querySelector("#event-model-progress");
const nativeCompanionResult = document.querySelector("#native-companion-result");
const eventModelDiagnostics = document.querySelector("#event-model-diagnostics-output");
const eventModelDiagnosticsPanel = document.querySelector("#event-model-diagnostics");
const copyEventModelDiagnosticsButton = document.querySelector(
  "#copy-event-model-diagnostics",
);
const refreshEventModelDiagnosticsButton = document.querySelector(
  "#refresh-event-model-diagnostics",
);
const NATIVE_EVENT_MODEL_ID = "onnx-community/Qwen3.5-0.8B-ONNX";
const NATIVE_EVENT_HOST_VERSION = "0.13.9";
const EVENT_MODEL_RUNTIME_VERSION = 30;
const BACKGROUND_HEALTH_TIMEOUT_MS = 10 * 1000;
const EMBEDDING_TEST_TIMEOUT_MS = 8 * 60 * 1000;
const EVENT_MODEL_TEST_TIMEOUT_MS = 20 * 60 * 1000;

async function assertBackgroundResponsive() {
  const health = await withTimeout(
    messenger.runtime.sendMessage({ type: "background-health" }),
    BACKGROUND_HEALTH_TIMEOUT_MS,
    "Local Triage's background bootstrap did not respond within ten seconds. Disable and re-enable the extension, then reopen Settings.",
  );
  if (!health?.ok) {
    const failure = health?.lastError;
    const detail = failure?.message
      ? `${failure.source ?? "startup"}: ${failure.message}`
      : `startup stopped in phase “${health?.phase ?? "unknown"}”`;
    throw new Error(
      `Local Triage's background initialization failed (${detail}). ` +
      "Disable and re-enable the extension, then retry.",
    );
  }

  const response = await withTimeout(
    messenger.runtime.sendMessage({ type: "ping" }),
    BACKGROUND_HEALTH_TIMEOUT_MS,
    "Local Triage's main request handler did not respond within ten seconds",
  );
  if (!response?.ok) {
    throw new Error(
      response?.error ??
      "Local Triage's main request handler is unavailable even though its bootstrap is running.",
    );
  }
}

async function sendBackgroundMessage(request, timeoutMs, activity) {
  await assertBackgroundResponsive();
  return withTimeout(
    messenger.runtime.sendMessage(request),
    timeoutMs,
    `${activity} timed out`,
  );
}

function renderEmbeddingModelStatus(status) {
  if (!status || status.backend !== "native" ||
      status.runtimeVersion !== EVENT_MODEL_RUNTIME_VERSION) {
    embeddingModelProgress.hidden = true;
    return;
  }
  const percent = Number.isFinite(status.percent) ? status.percent : undefined;
  if (percent == null) embeddingModelProgress.removeAttribute("value");
  else embeddingModelProgress.value = percent;
  embeddingModelProgress.hidden = status.state === "error";
  if (status.state === "ready") {
    testResult.textContent = "Ready: bilingual embedding model cached on native CPU.";
  } else if (status.state === "error") {
    testResult.textContent = status.error ?? status.detail ?? "Embedding model unavailable.";
  } else {
    testResult.textContent = status.detail ?? "Preparing the bilingual embedding model…";
  }
}

function populate(settings) {
  form.enabled.checked = settings.enabled;
  form.useEmbeddings.checked = settings.useEmbeddings;
  form.starUrgent.checked = settings.starUrgent;
  form.modelId.value = settings.modelId;
  form.minimumCategoryConfidence.value = settings.minimumCategoryConfidence;
  form.maximumBodyCharacters.value = settings.maximumBodyCharacters;
  form.categories.value = categoriesToText(settings.categories);
}

function readForm() {
  return normalizeSettings({
    enabled: form.enabled.checked,
    useEmbeddings: form.useEmbeddings.checked,
    starUrgent: form.starUrgent.checked,
    modelId: form.modelId.value.trim(),
    modelDtype: "q8",
    minimumCategoryConfidence: Number(form.minimumCategoryConfidence.value),
    maximumBodyCharacters: Number(form.maximumBodyCharacters.value),
    categories: categoriesFromText(form.categories.value),
  });
}

function showNotice(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function renderEventModelStatus(status) {
  if (!status) {
    eventModelResult.textContent =
      "Not prepared yet. Qwen3.5 downloads approximately 668 MB once and runs on native CPU.";
    eventModelResult.classList.remove("error");
    eventModelProgress.hidden = true;
    return;
  }

  eventModelResult.classList.toggle("error", status.state === "error");
  eventModelButton.disabled = status.state === "loading";
  if (
    status.modelId !== NATIVE_EVENT_MODEL_ID ||
    status.runtimeVersion !== EVENT_MODEL_RUNTIME_VERSION
  ) {
    eventModelResult.textContent =
      "The event model runtime has changed. Download and test Qwen3.5 again.";
    eventModelButton.disabled = false;
    eventModelProgress.hidden = true;
    return;
  }
  if (status.state === "idle") {
    eventModelResult.textContent = status.detail ?? "The event model is not prepared.";
    eventModelProgress.hidden = true;
    return;
  }
  if (status.state === "ready") {
    const runtime = `${status.device ?? "unknown"} / ${status.dtype ?? "unknown"}`;
    eventModelResult.textContent = `Ready: Qwen3.5 native CPU is cached locally (${runtime}).`;
    eventModelProgress.value = 100;
    eventModelProgress.hidden = false;
    return;
  }
  if (status.state === "error") {
    const runtime = status.device || status.dtype
      ? ` [${status.device ?? "unknown"} / ${status.dtype ?? "unknown"}]`
      : "";
    eventModelResult.textContent = `Unavailable${runtime}: ${status.error ?? "unknown error"}`;
    eventModelProgress.hidden = true;
    eventModelDiagnosticsPanel.open = true;
    refreshEventModelDiagnostics();
    return;
  }

  const percent = Number.isFinite(status.percent) ? status.percent : undefined;
  const file = String(status.file ?? "").split("/").pop();
  eventModelResult.textContent = status.detail || (percent == null
    ? "Preparing the local event model…"
    : `Downloading event model: ${percent}%${file ? ` (${file})` : ""}`);
  if (percent == null) {
    eventModelProgress.removeAttribute("value");
  } else {
    eventModelProgress.value = percent;
  }
  eventModelProgress.hidden = false;
}

function renderNativeCompanionStatus(status) {
  if (!status) {
    nativeCompanionResult.textContent =
      "Windows companion not checked yet. The event-model test checks it first.";
    nativeCompanionResult.classList.remove("error");
    return;
  }
  const available = status.state === "ready" || status.state === "loading";
  nativeCompanionResult.classList.toggle("error", status.state === "error");
  nativeCompanionResult.textContent = available
    ? status.detail ?? "Native Windows companion connected."
    : `${status.detail ?? "Native Windows companion unavailable."}${status.error ? ` ${status.error}` : ""}`;
}

function formatEventModelDiagnostics(report) {
  if (!report) return "No diagnostics captured yet.";
  const extensionVersion = messenger.runtime.getManifest().version;
  const header = [
    `Generated: ${report.generatedAt ?? report.nativeCompanion?.generatedAt ?? "unknown"}`,
    `Extension version: ${extensionVersion}`,
      `Expected companion: ${NATIVE_EVENT_HOST_VERSION} / runtime ${EVENT_MODEL_RUNTIME_VERSION}`,
    `Backend used by the last request: ${report.activeBackend ?? "unknown"}`,
    "",
  ];
  const native = report.nativeCompanion;
  if (native) {
    header.push(
      "Native Windows companion:",
      `Host version: ${native.hostVersion ?? "unknown"}`,
      `Runtime version: ${native.runtimeVersion ?? "unknown"}`,
      `State: ${native.state ?? "unknown"}`,
      `Last generation: ${native.lastGenerationState ?? "unknown"}`,
      `Device: ${native.device ?? "unknown"}`,
      `Worker: ${JSON.stringify(native.worker ?? {})}`,
      `Error: ${native.error ?? "none"}`,
      `Environment: ${JSON.stringify(native.environment ?? {})}`,
    );
    for (const entry of native.entries ?? []) {
      header.push(
        `${entry.at ?? ""} [native.${entry.stage ?? "unknown"}] ${JSON.stringify(entry.details ?? {})}`,
      );
    }
  }
  const lines = (report.entries ?? []).map(({ at, stage, message }) =>
    `${at ?? ""} [${stage ?? "unknown"}] ${message ?? ""}`,
  );
  if (report.modelId || lines.length) {
    header.push(
      "",
      "Legacy browser diagnostics:",
      `Model: ${report.modelId ?? "unknown"}`,
      `State: ${report.state ?? "unknown"}`,
    );
  }
  return [...header, ...lines].join("\n");
}

async function refreshEventModelDiagnostics() {
  try {
    const response = await sendBackgroundMessage(
      { type: "event-model-get-diagnostics" },
      BACKGROUND_HEALTH_TIMEOUT_MS,
      "Retrieving event-model diagnostics",
    );
    if (response?.diagnostics) {
      eventModelDiagnostics.value = formatEventModelDiagnostics(
        response.diagnostics,
      );
    } else if (response?.error) {
      eventModelDiagnostics.value = `Could not retrieve diagnostics: ${response.error}`;
    }
  } catch (error) {
    const { eventModelDiagnostics: stored } = await messenger.storage.local.get(
      "eventModelDiagnostics",
    );
    eventModelDiagnostics.value = stored
      ? formatEventModelDiagnostics(stored)
      : `Could not retrieve diagnostics: ${error?.message ?? error}`;
  }
}

async function copyEventModelDiagnostics() {
  await refreshEventModelDiagnostics();
  const text = eventModelDiagnostics.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    eventModelDiagnostics.focus();
    eventModelDiagnostics.select();
    document.execCommand("copy");
  }
  copyEventModelDiagnosticsButton.textContent = "Copied";
  setTimeout(() => {
    copyEventModelDiagnosticsButton.textContent = "Copy diagnostics";
  }, 1500);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveSettings(readForm());
    showNotice("Settings saved.");
  } catch (error) {
    showNotice(String(error.message ?? error), true);
  }
});

document.querySelector("#reset").addEventListener("click", () => {
  populate(normalizeSettings(DEFAULT_SETTINGS));
  showNotice("Defaults restored in the form. Save to apply them.");
});

document.querySelector("#self-test").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  testResult.textContent =
    "Preparing the bilingual model in the native companion. The first run downloads approximately 120 MB…";
  embeddingModelProgress.hidden = false;
  embeddingModelProgress.removeAttribute("value");
  try {
    await saveSettings(readForm());
    const response = await sendBackgroundMessage(
      { type: "self-test" },
      EMBEDDING_TEST_TIMEOUT_MS,
      "Preparing the bilingual embedding model",
    );
    if (!response?.ok) throw new Error(response?.error ?? "Embedding model test failed.");
    const result = response.result;
    testResult.textContent = result.error
      ? `Fallback active: ${result.error}`
      : `Ready: ${result.category} / ${result.priority} (${result.engine}).`;
  } catch (error) {
    testResult.textContent = String(error.message ?? error);
  } finally {
    button.disabled = false;
  }
});

eventModelButton.addEventListener("click", async () => {
  eventModelButton.disabled = true;
  eventModelResult.classList.remove("error");
  eventModelResult.textContent =
    "Preparing Qwen3.5 with the native Windows backend…";
  eventModelProgress.hidden = false;
  eventModelProgress.removeAttribute("value");
  try {
    const response = await sendBackgroundMessage(
      { type: "event-model-self-test" },
      EVENT_MODEL_TEST_TIMEOUT_MS,
      "Preparing the event model",
    );
    if (!response?.ok) throw new Error(response?.error ?? "Event model test failed.");
    eventModelResult.textContent =
      `Ready (${response.result.engine}, ${response.result.device} / ${response.result.dtype}): “${response.result.title}”`;
    eventModelProgress.value = 100;
  } catch (error) {
    const { eventModelStatus } = await messenger.storage.local.get(
      "eventModelStatus",
    );
    if (eventModelStatus?.state === "error") {
      renderEventModelStatus(eventModelStatus);
    } else {
      eventModelResult.textContent = String(error?.message ?? error);
      eventModelResult.classList.add("error");
      eventModelProgress.hidden = true;
    }
  } finally {
    eventModelButton.disabled = false;
    await refreshEventModelDiagnostics();
  }
});

copyEventModelDiagnosticsButton.addEventListener(
  "click",
  copyEventModelDiagnostics,
);
refreshEventModelDiagnosticsButton.addEventListener(
  "click",
  refreshEventModelDiagnostics,
);
messenger.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.eventModelStatus) {
    renderEventModelStatus(changes.eventModelStatus.newValue);
  }
  if (areaName === "local" && changes.eventModelDiagnostics) {
    eventModelDiagnostics.value = formatEventModelDiagnostics(
      changes.eventModelDiagnostics.newValue,
    );
  }
  if (areaName === "local" && changes.nativeEventModelStatus) {
    renderNativeCompanionStatus(changes.nativeEventModelStatus.newValue);
  }
  if (areaName === "local" && changes.modelStatus) {
    renderEmbeddingModelStatus(changes.modelStatus.newValue);
  }
});

Promise.all([
  getSettings(),
  messenger.storage.local.get([
    "eventModelStatus",
    "eventModelDiagnostics",
    "nativeEventModelStatus",
    "modelStatus",
  ]),
])
  .then(([settings, stored]) => {
    populate(settings);
    renderEventModelStatus(stored.eventModelStatus);
    eventModelDiagnostics.value = formatEventModelDiagnostics(
      stored.eventModelDiagnostics,
    );
    renderNativeCompanionStatus(stored.nativeEventModelStatus);
    renderEmbeddingModelStatus(stored.modelStatus);
  })
  .catch((error) => showNotice(String(error.message ?? error), true));
