"use strict";

const backgroundState = globalThis.__localTriageBackgroundState ??= {
  phase: "bootstrap",
  startedAt: new Date().toISOString(),
  readyAt: undefined,
  lastError: undefined,
  optionalApisUnavailable: [],
};

function recordBackgroundFailure(error, source) {
  backgroundState.phase = backgroundState.readyAt ? "degraded" : "failed";
  backgroundState.lastError = {
    source,
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    at: new Date().toISOString(),
  };
}

globalThis.addEventListener?.("error", (event) => {
  recordBackgroundFailure(event.error ?? event.message, "error");
});
globalThis.addEventListener?.("unhandledrejection", (event) => {
  recordBackgroundFailure(event.reason, "unhandledrejection");
});

messenger.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type !== "background-health") return false;
  sendResponse({
    ok: ["ready", "degraded"].includes(backgroundState.phase),
    ...backgroundState,
    extensionVersion: messenger.runtime.getManifest().version,
    checkedAt: new Date().toISOString(),
  });
  return false;
});
