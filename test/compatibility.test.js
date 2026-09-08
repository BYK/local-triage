import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("../static/manifest.json", import.meta.url), "utf8"),
);
const calendarBridgeSource = await readFile(
  new URL("../static/experiments/calendar-bridge/implementation.js", import.meta.url),
  "utf8",
);
const calendarBridgeSchema = JSON.parse(
  await readFile(
    new URL("../static/experiments/calendar-bridge/schema.json", import.meta.url),
    "utf8",
  ),
);
const eventModelClientSource = await readFile(
  new URL("../src/event-model-client.js", import.meta.url),
  "utf8",
);
const eventCacheSource = await readFile(
  new URL("../src/event-cache.js", import.meta.url),
  "utf8",
);
const nativeEventModelClientSource = await readFile(
  new URL("../src/native-event-model-client.js", import.meta.url),
  "utf8",
);
const classifierSource = await readFile(
  new URL("../src/classifier.js", import.meta.url),
  "utf8",
);
const nativeHostSource = await readFile(
  new URL("../native/directml-host/host.cjs", import.meta.url),
  "utf8",
);
const nativeInstallerSource = await readFile(
  new URL("../native/directml-host/install.ps1", import.meta.url),
  "utf8",
);
const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);
const backgroundHealthSource = await readFile(
  new URL("../static/background-health.js", import.meta.url),
  "utf8",
);
const optionsHtml = await readFile(
  new URL("../static/options.html", import.meta.url),
  "utf8",
);
const optionsSource = await readFile(
  new URL("../src/options.js", import.meta.url),
  "utf8",
);
const popupHtml = await readFile(
  new URL("../static/popup.html", import.meta.url),
  "utf8",
);
const popupSource = await readFile(
  new URL("../src/popup.js", import.meta.url),
  "utf8",
);
const buildSource = await readFile(
  new URL("../scripts/build.mjs", import.meta.url),
  "utf8",
);
const nativeBuildSource = await readFile(
  new URL("../scripts/build-native-host-fossilize.mjs", import.meta.url),
  "utf8",
);

test("package and extension versions stay synchronized", () => {
  assert.equal(manifest.version, packageJson.version);
});

test("Thunderbird compatibility has no maximum-version cap", () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.equal(gecko.strict_min_version, "153.0");
  assert.equal("strict_max_version" in gecko, false);
});

test("background startup is observable and optional APIs cannot abort it", () => {
  assert.deepEqual(manifest.background.scripts, [
    "background-health.js",
    "background.js",
  ]);
  assert.match(backgroundHealthSource, /type !== "background-health"/);
  assert.match(backgroundHealthSource, /unhandledrejection/);
  assert.match(backgroundSource, /function addExtensionListener/);
  assert.match(backgroundSource, /messageDisplay\?\.onMessagesDisplayed/);
  assert.match(backgroundSource, /calendarBridge\?\.onActionClicked/);
  assert.match(backgroundSource, /\(request, _sender, sendResponse\) =>/);
  assert.doesNotMatch(backgroundSource, /onMessage\.addListener\(async/);
  assert.match(backgroundSource, /localTriageBackgroundState\.phase = "ready"/);
  assert.match(optionsSource, /type: "background-health"/);
  assert.match(optionsSource, /background initialization failed/);
  assert.match(calendarBridgeSource, /could not initialize its Conversations integration/);
});

test("native CPU companion is the only event-model backend", () => {
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.match(nativeEventModelClientSource, /im\.byk\.local_triage/);
  assert.match(nativeEventModelClientSource, /connectNative\(NATIVE_EVENT_HOST\)/);
  assert.match(nativeEventModelClientSource, /let connectionPromise/);
  assert.match(nativeEventModelClientSource, /prepareNativeEventModel/);
  assert.match(nativeEventModelClientSource, /generateNativeEventDetails/);
  assert.match(eventModelClientSource, /return prepareNativeEventModel\(\)/);
  assert.match(eventModelClientSource, /return generateNativeEventDetails\(\{ \.\.\.input, detectedEvent \}\)/);
  assert.doesNotMatch(eventModelClientSource, /requestRunner|WebGPU|Wllama/);
  assert.match(nativeHostSource, /device: variant\.pipelineDevice/);
  assert.match(nativeHostSource, /const DEVICE = "cpu"/);
  assert.match(nativeHostSource, /Qwen3\.5-0\.8B-ONNX/);
  assert.match(nativeHostSource, /const DTYPE = "q4"/);
  assert.match(nativeHostSource, /function cpuVariant\(\)/);
  assert.match(nativeHostSource, /executionProviders: \["cpu"\]/);
  assert.doesNotMatch(nativeHostSource, /pipelineDevice: "dml"|retry-directml|cache-free decoder/);
  assert.match(nativeHostSource, /await smokeTest\(candidate, variant\)/);
  assert.match(nativeHostSource, /hasCurrentCpuValidation\(\)/);
  assert.match(nativeHostSource, /rememberCpuValidation\(\)/);
  assert.match(nativeHostSource, /use_cache: true/);
  assert.match(nativeHostSource, /function tokenProgressStreamer/);
  assert.match(nativeHostSource, /inference\.token\.progress/);
  assert.match(nativeHostSource, /const detected = input\?\.detectedEvent/);
  assert.match(nativeHostSource, /Do not extract date, time, duration, or location/);
  assert.match(nativeHostSource, /executionMode: "sequential"/);
  assert.match(nativeHostSource, /enableMemPattern: false/);
  assert.match(nativeHostSource, /graphOptimizationLevel: variant\.graphOptimizationLevel/);
  assert.match(nativeHostSource, /function extractGeneratedText\(output\)/);
  assert.match(nativeHostSource, /textFromContent\(assistant\.content/);
  assert.match(nativeHostSource, /generatedTextShape/);
  assert.match(nativeHostSource, /const lastBuckets = new Map\(\)/);
  assert.match(nativeHostSource, /function assertCompleteInstallation\(\)/);
  assert.match(nativeHostSource, /prepareEmbeddedRuntime\(\)/);
  assert.match(nativeHostSource, /getRawAsset\(key\)/);
  assert.match(nativeHostSource, /argv\.includes\("--install"\)/);
  assert.match(nativeHostSource, /pipelinePromise/);
  assert.match(nativeHostSource, /generationQueue/);
  assert.match(nativeEventModelClientSource, /NATIVE_EVENT_HOST_VERSION = "0\.13\.9"/);
  assert.match(nativeEventModelClientSource, /handshake\?\.runtimeVersion !== EVENT_MODEL_RUNTIME_VERSION/);
  assert.match(nativeEventModelClientSource, /handshake\?\.embeddingModelId !== NATIVE_EMBEDDING_MODEL_ID/);
  assert.match(nativeEventModelClientSource, /NATIVE_EVENT_HOST_INCOMPATIBLE/);
  assert.match(nativeEventModelClientSource, /state: "incompatible"/);
  assert.match(nativeHostSource, /function assertThunderbirdStopped\(\)/);
  assert.match(nativeHostSource, /IMAGENAME eq thunderbird\.exe/);
  assert.match(nativeHostSource, /Host\(\?:-\.\*\)\?\\\.exe/);
  assert.ok(
    nativeEventModelClientSource.indexOf("if (connectionPromise) return connectionPromise") <
    nativeEventModelClientSource.indexOf("if (port && lastHandshake) return port"),
  );
  assert.match(nativeHostSource, /LOCAL_TRIAGE_MODEL_WORKER_ACTIVITY_TIMEOUT_MS/);
  assert.match(nativeHostSource, /native-supervisor-wait/);
  assert.match(nativeHostSource, /runNativeMessaging\(handleSupervisor\)/);
  assert.doesNotMatch(nativeEventModelClientSource, /retryNativeDirectML|directml\+cpu/i);
  assert.doesNotMatch(backgroundSource, /event-model-retry-directml/);
  assert.doesNotMatch(optionsHtml, /retry-directml/i);
  assert.match(nativeHostSource, /writeUInt32LE/);
  assert.match(nativeInstallerSource, /Software\\Mozilla\\NativeMessagingHosts/);
  assert.match(nativeInstallerSource, /allowed_extensions/);
  assert.match(nativeInstallerSource, /NativeHost\.installing-/);
  assert.match(nativeInstallerSource, /Companion archive is incomplete/);
  assert.match(nativeBuildSource, /import \{ fossilize \} from "fossilize"/);
  assert.match(nativeBuildSource, /platforms: \["win-x64"\]/);
  assert.match(nativeBuildSource, /assets: assetPaths/);
  assert.match(nativeBuildSource, /LOCAL_TRIAGE_ORT_BINDING/);
  assert.match(nativeBuildSource, /"local-triage\.xpi"/);
  assert.match(nativeBuildSource, /installer-manifest\.json/);
  assert.match(nativeBuildSource, /createHash\("sha256"\)/);
  assert.match(nativeBuildSource, /local-triage-windows-installer-/);
  assert.match(nativeBuildSource, /const outputName = "LocalTriageNativeHost"/);
  assert.doesNotMatch(nativeBuildSource, /"DirectML\.dll"|"dxcompiler\.dll"|"dxil\.dll"/);
  assert.match(nativeHostSource, /extractEmbeddedExtension/);
  assert.match(nativeHostSource, /failed its SHA-256 integrity check/);
  assert.match(nativeHostSource, /findDefaultThunderbirdProfile/);
  assert.match(nativeHostSource, /installExtensionIntoDefaultProfile/);
  assert.match(nativeHostSource, /path\.join\(extensionsDirectory, `\$\{EXTENSION_ID\}\.xpi`\)/);
  assert.doesNotMatch(nativeHostSource, /launchExtensionInstall/);
  assert.match(nativeHostSource, /function detectLaunchMode/);
  assert.match(nativeHostSource, /isNativeMessagingInvocation/);
  assert.match(nativeHostSource, /isStandaloneHostExecutable/);
  assert.doesNotMatch(nativeHostSource, /process\.argv\.length === 1/);
  assert.match(nativeHostSource, /verifyInstalledHostExecutable/);
  assert.match(nativeHostSource, /failed its SHA-256 check/);
  assert.match(nativeHostSource, /stopInstalledHostProcesses/);
  assert.match(nativeHostSource, /taskkill\.exe/);
  assert.match(nativeHostSource, /Verified runtime/);
});

test("calendar actions use the native message quick actions and context menu", () => {
  assert.ok(manifest.permissions.includes("menus"));
  assert.ok(manifest.permissions.includes("notifications"));
  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(
    manifest.message_display_action.default_icon,
    "icons/calendar.svg",
  );
  assert.equal(manifest.message_display_action.default_label, "");
  assert.equal(
    manifest.message_display_action.default_popup,
    "popup.html?eventReview=1",
  );
  assert.equal("quickAction" in manifest.experiment_apis, false);
});

test("reviewed calendar creation is isolated in a narrow experiment", () => {
  const experiment = manifest.experiment_apis.calendarBridge;
  assert.equal(experiment.schema, "experiments/calendar-bridge/schema.json");
  assert.equal(
    experiment.parent.script,
    "experiments/calendar-bridge/implementation.js",
  );
  assert.match(calendarBridgeSource, /new CalEvent\(ics\)/);
  assert.match(calendarBridgeSource, /calendar\.addItem\(item\)/);
  assert.doesNotMatch(calendarBridgeSource, /adoptItem/);
  assert.doesNotMatch(calendarBridgeSource, /createEventWithDialog/);
  assert.match(calendarBridgeSource, /ExtensionUtils\.sys\.mjs/);
  assert.match(calendarBridgeSource, /new ExtensionError\(message\)/);
  const functions = Object.fromEntries(
    calendarBridgeSchema[0].functions.map((entry) => [entry.name, entry]),
  );
  assert.equal(functions.list.returns.type, "array");
  assert.equal("open" in functions, false);
  assert.equal(functions.create.returns.$ref, "EventOperationResult");
});

test("Thunderbird Conversations gets a conditional top-toolbar calendar action", () => {
  assert.match(calendarBridgeSource, /chrome:\/\/conversations\//);
  assert.match(calendarBridgeSource, /querySelector\("conversation-header"\)/);
  assert.match(calendarBridgeSource, /querySelector\("conv-actions-buttons"\)/);
  assert.match(calendarBridgeSource, /root\.querySelector\("\.archive"\)/);
  assert.match(calendarBridgeSource, /MutationObserver/);
  assert.match(calendarBridgeSource, /CONVERSATIONS_ACTION_ATTRIBUTE/);
  assert.match(calendarBridgeSource, /EVENT_TAG_KEY = "localtriage-event"/);
  assert.match(calendarBridgeSource, /button\.hidden = !visible/);
  assert.match(calendarBridgeSource, /setDetectedMessages/);
  assert.match(calendarBridgeSource, /detectedMessageIds/);
  assert.match(
    calendarBridgeSource,
    /Boolean\(detectedIds\?\.length\) \|\| hasEventTag\(header\)/,
  );
  assert.match(calendarBridgeSource, /messageDisplayAction-toolbarbutton/);
  const namespace = calendarBridgeSchema[0];
  assert.equal(namespace.functions.some(({ name }) => name === "setActionState"), false);
  assert.ok(namespace.functions.some(({ name }) => name === "setDetectedMessages"));
  assert.ok(namespace.events.some(({ name }) => name === "onActionClicked"));
  assert.match(backgroundSource, /calendarBridge\?\.onActionClicked/);
  assert.match(backgroundSource, /messageDisplay\?\.onMessagesDisplayed/);
  assert.match(backgroundSource, /updateDisplayedEventActions/);
  assert.match(popupHtml, /id="create-event"[^>]+hidden/);
  assert.match(popupSource, /eventRequestPayload\("probe-event-selected"\)/);
  assert.match(popupSource, /eventRequestPayload\("prepare-event-review-selected"\)/);
  assert.match(popupSource, /type: "claim-event-review-target"/);
  assert.match(popupSource, /await openEventReview\(\)/);
  assert.match(popupSource, /tabId,/);
  assert.match(popupSource, /eventCalendarWarning/);
  assert.match(popupSource, /sendBackgroundMessage/);
  assert.doesNotMatch(popupSource, /type: "list-calendars"/);
  assert.match(backgroundSource, /function setDetectedEventAction/);
  assert.match(backgroundSource, /Could not synchronize the detected-event action/);
  assert.match(backgroundSource, /Default Thunderbird calendar/);
  assert.match(backgroundSource, /messenger\.action\.openPopup\(\)/);
  assert.match(backgroundSource, /pendingEventReviewTarget/);
  assert.doesNotMatch(backgroundSource, /calendarBridge\.open/);
  assert.doesNotMatch(calendarBridgeSource, /local-triage-calendar-badge/);
});

test("the event model has one race-free native load promise", () => {
  assert.match(backgroundSource, /eventEnrichmentPromises/);
  assert.doesNotMatch(backgroundSource, /eventCreationPromises/);
  assert.match(eventModelClientSource, /EVENT_MODEL_RUNTIME_VERSION = 30/);
  assert.match(nativeHostSource, /let pipelinePromise/);
  assert.match(nativeHostSource, /if \(!pipelinePromise\)/);
  assert.match(nativeHostSource, /generationQueue = generationQueue\.then/);
  assert.match(nativeEventModelClientSource, /if \(!eventReady\) await prepareNativeEventModel\(\)/);
  assert.match(nativeEventModelClientSource, /let eventPreparationPromise/);
  assert.match(nativeHostSource, /function generatedTextSanity\(text, input = \{\}\)/);
  assert.match(nativeHostSource, /inference\.sanity/);
  assert.match(nativeHostSource, /safeSyntheticOutput/);
  assert.match(nativeHostSource, /START\[_ -\]\?DATE/);
  assert.match(
    backgroundSource,
    /generateDetails \? generateEventDetails : undefined/,
  );
  assert.match(eventModelClientSource, /export function isEventModelBusy\(\)/);
  assert.match(backgroundSource, /EVENT_MODEL_RECOVERY_GRACE_MS = 15 \* 1000/);
  assert.match(backgroundSource, /scheduleInterruptedEventModelRecovery/);
  assert.match(backgroundSource, /if \(isEventModelBusy\(\)\) return/);
  assert.match(backgroundSource, /current\.updatedAt !== observedStatus\.updatedAt/);
  assert.equal("modelHost" in manifest.experiment_apis, false);
});

test("detected events are prefetched and persistently cached", () => {
  assert.match(backgroundSource, /createEventDetailsCache/);
  assert.match(backgroundSource, /scheduleEventPrefetch/);
  assert.match(backgroundSource, /detectedResults/);
  assert.match(backgroundSource, /INTERACTIVE_EVENT_WAIT_TIMEOUT_MS = 8 \* 1000/);
  assert.match(backgroundSource, /interactive-fallback/);
  assert.match(eventCacheSource, /EVENT_DETAILS_CACHE_LIMIT = 200/);
  assert.match(eventCacheSource, /EVENT_DETAILS_CACHE_VERSION = 2/);
  assert.match(eventCacheSource, /enrichmentCache: "hit"/);
  assert.match(popupSource, /cache: event\.enrichmentCache/);
});

test("embedding inference runs in the native companion instead of Thunderbird WASM", () => {
  assert.match(nativeHostSource, /const EMBEDDING_MODEL_ID = "Xenova\/multilingual-e5-small"/);
  assert.match(nativeHostSource, /case "prepare-embedding"/);
  assert.match(nativeHostSource, /case "embed"/);
  assert.match(nativeHostSource, /let embeddingPipelinePromise/);
  assert.match(nativeEventModelClientSource, /prepareNativeEmbeddingModel/);
  assert.match(nativeEventModelClientSource, /embedNativeTexts/);
  assert.match(classifierSource, /embedNativeTexts/);
  assert.doesNotMatch(classifierSource, /@huggingface\/transformers|onnx|wasm/i);
  assert.doesNotMatch(buildSource, /ort-wasm-|onnxruntime-web/);
  assert.equal("host_permissions" in manifest, false);
  assert.doesNotMatch(
    manifest.content_security_policy.extension_pages,
    /wasm-unsafe-eval|huggingface|worker-src/,
  );
});

test("settings can prepare the event model and show its progress", () => {
  assert.match(optionsHtml, /id="event-model-self-test"/);
  assert.match(optionsHtml, /id="event-model-progress"/);
  assert.match(optionsHtml, /Qwen3\.5 0\.8B/);
  assert.match(optionsHtml, /native\s+CPU companion/);
  assert.match(optionsHtml, /approximately 668 MB/);
  assert.match(optionsHtml, /Deterministic extraction owns the event date, time, duration, and\s+location/);
  assert.doesNotMatch(optionsHtml, /WebGPU|llama\.cpp|DirectML/i);
  assert.match(optionsHtml, /id="copy-event-model-diagnostics"/);
  assert.match(optionsHtml, /Email subjects and\s+bodies are not included/);
  assert.match(backgroundSource, /case "event-model-self-test"/);
  assert.match(backgroundSource, /case "event-model-get-diagnostics"/);
  assert.match(backgroundSource, /case "ping"/);
  assert.match(backgroundSource, /eventModelStatus\.runtimeVersion !== EVENT_MODEL_RUNTIME_VERSION/);
  assert.match(nativeHostSource, /const MAX_DIAGNOSTICS = 250/);
  assert.match(popupSource, /eventModelStatus/);
  assert.match(optionsHtml, /id="embedding-model-progress"/);
  assert.match(optionsSource, /assertBackgroundResponsive/);
  assert.match(optionsSource, /BACKGROUND_HEALTH_TIMEOUT_MS = 10 \* 1000/);
  assert.match(optionsSource, /EMBEDDING_TEST_TIMEOUT_MS = 8 \* 60 \* 1000/);
  assert.match(optionsSource, /EVENT_MODEL_TEST_TIMEOUT_MS = 20 \* 60 \* 1000/);
  assert.match(optionsSource, /renderEmbeddingModelStatus/);
});

test("extension packaging excludes native-only inference runtimes", () => {
  assert.doesNotMatch(buildSource, /event-runner/);
  assert.doesNotMatch(buildSource, /requiredWasmRuntimeFiles|ort-wasm-|onnxRuntimeDist/);
});

test("packaging excludes retired browser event-model runtimes", () => {
  assert.doesNotMatch(buildSource, /wllama|eventRunner|WebGPU/i);
  assert.equal("@wllama/wllama" in packageJson.dependencies, false);
  assert.equal("@wllama/wllama-compat" in packageJson.dependencies, false);
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'",
  );
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
});
