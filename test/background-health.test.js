import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../static/background-health.js", import.meta.url),
  "utf8",
);

function loadHealthBootstrap() {
  const messageListeners = [];
  const windowListeners = new Map();
  const context = {
    Date,
    messenger: {
      runtime: {
        getManifest: () => ({ version: "0.13.13" }),
        onMessage: {
          addListener: (listener) => messageListeners.push(listener),
        },
      },
    },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "background-health.js" });
  return { context, messageListeners, windowListeners };
}

function requestHealth(listener) {
  let response;
  const returned = listener(
    { type: "background-health" },
    {},
    (value) => { response = value; },
  );
  assert.equal(returned, false);
  return response;
}

test("background health responds before the main bundle has loaded", () => {
  const { messageListeners } = loadHealthBootstrap();
  assert.equal(messageListeners.length, 1);
  const response = requestHealth(messageListeners[0]);
  assert.equal(response.ok, false);
  assert.equal(response.phase, "bootstrap");
  assert.equal(response.extensionVersion, "0.13.13");
});

test("background health captures startup exceptions instead of timing out", () => {
  const { messageListeners, windowListeners } = loadHealthBootstrap();
  windowListeners.get("error")({ error: new Error("missing optional API") });
  const response = requestHealth(messageListeners[0]);
  assert.equal(response.ok, false);
  assert.equal(response.phase, "failed");
  assert.equal(response.lastError.message, "missing optional API");
});

test("post-startup errors report a responsive but degraded background", () => {
  const { context, messageListeners, windowListeners } = loadHealthBootstrap();
  context.__localTriageBackgroundState.phase = "ready";
  context.__localTriageBackgroundState.readyAt = new Date().toISOString();
  windowListeners.get("unhandledrejection")({
    reason: new Error("later task failed"),
  });
  const response = requestHealth(messageListeners[0]);
  assert.equal(response.ok, true);
  assert.equal(response.phase, "degraded");
  assert.equal(response.lastError.message, "later task failed");
});

test("background health ignores unrelated messages", () => {
  const { messageListeners } = loadHealthBootstrap();
  let responded = false;
  const returned = messageListeners[0](
    { type: "self-test" },
    {},
    () => { responded = true; },
  );
  assert.equal(returned, false);
  assert.equal(responded, false);
});
