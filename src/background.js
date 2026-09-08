import {
  classify,
  resetClassifier,
} from "./classifier.js";
import {
  clearEventModelDiagnostics,
  EVENT_MODEL_ID,
  EVENT_MODEL_RUNTIME_VERSION,
  generateEventDetails,
  getEventModelDiagnostics,
  isEventModelBusy,
  prepareEventModel,
} from "./event-model-client.js";
import { EVENT_TAG } from "./defaults.js";
import { createEventDetailsCache } from "./event-cache.js";
import { createIcs, detectEvent, enrichEvent } from "./events.js";
import { collectMessageList, extractMessage } from "./message.js";
import { storeRanking } from "./rankings.js";
import { getSettings } from "./settings.js";
import {
  applyClassification,
  applyEventTag,
  ensureTags,
  hasClassificationTag,
} from "./tags.js";
import { withTimeout } from "./timeout.js";

const localTriageBackgroundState = globalThis.__localTriageBackgroundState ?? {
  phase: "bootstrap-missing",
  startedAt: new Date().toISOString(),
  readyAt: undefined,
  lastError: undefined,
  optionalApisUnavailable: [],
};
globalThis.__localTriageBackgroundState = localTriageBackgroundState;
localTriageBackgroundState.phase = "initializing";
localTriageBackgroundState.mainStartedAt = new Date().toISOString();

function recordOptionalApiFailure(name, error) {
  localTriageBackgroundState.optionalApisUnavailable ??= [];
  localTriageBackgroundState.optionalApisUnavailable.push({
    name,
    error: error?.message ?? String(error),
    at: new Date().toISOString(),
  });
}

function addExtensionListener(event, name, listener, required = false) {
  try {
    if (typeof event?.addListener !== "function") {
      throw new Error(`${name} is not available in this Thunderbird build`);
    }
    event.addListener(listener);
    return true;
  } catch (error) {
    recordOptionalApiFailure(name, error);
    if (required) throw error;
    console.warn(`Local Triage disabled optional integration ${name}`, error);
    return false;
  }
}

function runStartupTask(name, operation) {
  try {
    Promise.resolve(operation()).catch((error) => {
      recordOptionalApiFailure(name, error);
      console.error(`Local Triage startup task ${name} failed`, error);
    });
  } catch (error) {
    recordOptionalApiFailure(name, error);
    console.error(`Local Triage startup task ${name} failed`, error);
  }
}

let queue = Promise.resolve();
let initialTriagePromise;
let inboxScanPromise;
const queuedMessageIds = new Set();
const eventEnrichmentPromises = new Map();
const displayedEventDetectionVersions = new Map();
const scheduledEventPrefetches = new Set();
let eventPrefetchQueue = Promise.resolve();
let pendingEventReviewTarget;

const INITIAL_TRIAGE_VERSION = 4;
const INITIAL_TRIAGE_LIMIT = 50;
const INBOX_SCAN_LIMIT = 25;
const EVENT_MODEL_RECOVERY_GRACE_MS = 15 * 1000;
let eventModelRecoveryTimer;
const INBOX_SCAN_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const INBOX_SCAN_OVERLAP_MS = 5 * 60 * 1000;
const MESSAGE_EXTRACTION_TIMEOUT_MS = 60 * 1000;
const INTERACTIVE_EVENT_WAIT_TIMEOUT_MS = 8 * 1000;
const CREATE_EVENT_MENU_ID = "local-triage-create-calendar-event";
const eventDetailsCache = createEventDetailsCache(messenger.storage.local, {
  modelId: EVENT_MODEL_ID,
  runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
});

async function setRunStatus(status) {
  await messenger.storage.local.set({
    runStatus: { ...status, updatedAt: new Date().toISOString() },
  });
}

async function processOne(header, settings, reportStage) {
  await reportStage("reading");
  const input = await withTimeout(
    extractMessage(header),
    MESSAGE_EXTRACTION_TIMEOUT_MS,
    "Reading the message timed out",
  );
  const event = detectEvent(input);
  await reportStage("classifying");
  const result = await classify(input, settings);
  await reportStage("applying");
  await Promise.all([
    applyClassification(header, result, settings, event.detected),
    storeRanking(header, result),
    messenger.smartOrder.setScore(header.id, result.score),
  ]);
  if (event.detected) {
    scheduleEventPrefetch(header, {
      delay: 3000,
      waitForTriage: true,
      input,
      detected: event,
    });
  }
  return {
    id: header.id,
    subject: header.subject,
    category: result.category.name,
    priority: result.priority.key,
    score: result.score,
    confidence: result.categoryConfidence,
    engine: result.engine,
    event: event.detected
      ? {
          title: event.title,
          startDate: event.startDate,
          startTime: event.startTime,
        }
      : null,
  };
}

async function storeEventDiagnostics(header, event) {
  await messenger.storage.local.set({
    lastEventDiagnostics: {
      updatedAt: new Date().toISOString(),
      messageId: header.id,
      subject: header.subject,
      engine: event.enrichmentEngine,
      cache: event.enrichmentCache,
      error: event.enrichmentError,
      fieldSources: event.fieldSources,
      modelOutput: event.modelOutput,
      final: {
        title: event.title,
        startDate: event.startDate,
        startTime: event.startTime,
        endDate: event.endDate,
        endTime: event.endTime,
        location: event.location,
        description: event.description,
      },
    },
  });
}

async function performEventDetection(
  header,
  enrich = false,
  preparedInput,
  preparedDetection,
  generateDetails = true,
) {
  const input = preparedInput ?? await withTimeout(
    extractMessage(header),
    MESSAGE_EXTRACTION_TIMEOUT_MS,
    "Reading the message timed out",
  );
  const detected = preparedDetection ?? detectEvent(input);
  const settings = enrich ? await getSettings() : undefined;
  if (settings) await ensureTags(settings);
  const event = enrich
    ? await enrichEvent(
        input,
        detected,
        generateDetails ? generateEventDetails : undefined,
      )
    : detected;
  if (enrich) event.enrichmentCache = "miss";
  await applyEventTag(header, event.detected);
  if (enrich) await storeEventDiagnostics(header, event);
  return event;
}

function detectAndTagEvent(header, enrich = false, preparedInput, preparedDetection) {
  if (!enrich) return performEventDetection(header, false);

  const key = eventDetailsCache.key(header);
  const existing = eventEnrichmentPromises.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const cached = await eventDetailsCache.get(header);
      if (cached) {
        await applyEventTag(header, cached.detected);
        await storeEventDiagnostics(header, cached);
        return cached;
      }
    } catch (error) {
      console.warn("Could not read cached event details", error);
    }

    const event = await performEventDetection(
      header,
      true,
      preparedInput,
      preparedDetection,
    );
    if (event.detected && !event.enrichmentError) {
      try {
        await eventDetailsCache.set(header, event);
      } catch (error) {
        console.warn("Could not cache event details", error);
      }
    }
    return event;
  })().finally(() => {
    if (eventEnrichmentPromises.get(key) === pending) {
      eventEnrichmentPromises.delete(key);
    }
  });
  eventEnrichmentPromises.set(key, pending);
  return pending;
}

function scheduleEventPrefetch(
  header,
  { delay = 0, waitForTriage = false, input, detected } = {},
) {
  const key = eventDetailsCache.key(header);
  if (scheduledEventPrefetches.has(key) || eventEnrichmentPromises.has(key)) return;
  scheduledEventPrefetches.add(key);

  const enqueueWhenReady = () => {
    if (waitForTriage && queuedMessageIds.size) {
      setTimeout(enqueueWhenReady, 1000);
      return;
    }
    eventPrefetchQueue = eventPrefetchQueue
      .then(() => detectAndTagEvent(header, true, input, detected))
      .catch((error) => {
        console.warn("Event detail prefetch failed", header.id, error);
      })
      .finally(() => scheduledEventPrefetches.delete(key));
  };
  setTimeout(enqueueWhenReady, delay);
}

async function updateDisplayedEventActions(tabId, messageList) {
  if (!Number.isInteger(tabId)) return;
  const version = (displayedEventDetectionVersions.get(tabId) ?? 0) + 1;
  displayedEventDetectionVersions.set(tabId, version);
  await messenger.calendarBridge?.setDetectedMessages?.(tabId, []);

  const headers = await collectMessageList(messageList);
  if (displayedEventDetectionVersions.get(tabId) !== version) return;
  const detectedIds = headers
    .filter((header) => (header.tags ?? []).includes(EVENT_TAG.key))
    .map((header) => header.id);
  if (detectedIds.length) {
    await messenger.calendarBridge?.setDetectedMessages?.(tabId, detectedIds);
  }

  await ensureTags(await getSettings());
  const results = await Promise.all(headers.map(async (header) => {
    try {
      return {
        id: header.id,
        event: await detectAndTagEvent(header, false),
      };
    } catch (error) {
      console.error("Failed to detect a displayed event", header.id, error);
      return { id: header.id, event: undefined };
    }
  }));
  if (displayedEventDetectionVersions.get(tabId) !== version) return;
  const detectedResults = results.filter(({ event }) => event?.detected);
  await messenger.calendarBridge?.setDetectedMessages?.(
    tabId,
    detectedResults.map(({ id }) => id),
  );
  for (const { id, event } of detectedResults) {
    const header = headers.find((candidate) => candidate.id === id);
    if (header) scheduleEventPrefetch(header, { detected: event });
  }
}

async function setDetectedEventAction(header, detected, requestedTabId) {
  try {
    if (!messenger.calendarBridge?.setDetectedMessages) return;
    let tabId = requestedTabId;
    if (!Number.isInteger(tabId)) {
      const [activeTab] = await messenger.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      tabId = activeTab?.id;
    }
    if (!Number.isInteger(tabId)) return;
    await messenger.calendarBridge.setDetectedMessages(
      tabId,
      detected ? [header.id] : [],
    );
  } catch (error) {
    // The Conversations/native toolbar is optional. A stale or unavailable
    // reader must never prevent the popup from opening the event editor.
    console.warn("Could not synchronize the detected-event action", error);
  }
}

async function scanCurrentlyDisplayedMessages() {
  const tabs = await messenger.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    try {
      const displayed = await messenger.messageDisplay.getDisplayedMessages(tab.id);
      if ((displayed.messages ?? []).length) {
        await updateDisplayedEventActions(tab.id, displayed);
      }
    } catch {
      // Non-mail tabs do not expose displayed messages.
    }
  }));
}

async function processMessages(headers, source = "manual") {
  const settings = await getSettings();
  if (!settings.enabled && ["automatic", "initial-view"].includes(source)) return [];
  if (!headers.length) return [];

  await setRunStatus({ state: "running", source, total: headers.length, completed: 0 });
  await ensureTags(settings);
  const results = [];
  const errors = [];

  for (const [index, header] of headers.entries()) {
    try {
      results.push(
        await processOne(header, settings, (stage) =>
          setRunStatus({
            state: "running",
            source,
            stage,
            current: index + 1,
            total: headers.length,
            completed: results.length + errors.length,
            errors: errors.length,
          }),
        ),
      );
    } catch (error) {
      console.error("Failed to classify message", header.id, error);
      errors.push({
        id: header.id,
        subject: header.subject,
        error: String(error?.message ?? error),
      });
    }
    await setRunStatus({
      state: "running",
      source,
      total: headers.length,
      completed: results.length + errors.length,
      errors: errors.length,
    });
  }

  await messenger.smartOrder.refresh();

  await setRunStatus({
    state: errors.length ? "completed-with-errors" : "completed",
    source,
    total: headers.length,
    completed: results.length,
    errors,
    results: results.slice(-20),
  });
  return results;
}

function enqueue(headers, source) {
  const uniqueHeaders = headers.filter((header) => {
    if (queuedMessageIds.has(header.id) && source !== "selected") return false;
    queuedMessageIds.add(header.id);
    return true;
  });
  if (!uniqueHeaders.length) return Promise.resolve([]);

  const task = queue
    .then(() => processMessages(uniqueHeaders, source))
    .finally(() => {
      for (const header of uniqueHeaders) queuedMessageIds.delete(header.id);
    });
  queue = task.catch(() => undefined);
  return task;
}

async function enqueueIndividually(headers, source) {
  const results = [];
  for (const header of headers) {
    results.push(...(await enqueue([header], source)));
  }
  return results;
}

async function scanUnclassifiedInboxes() {
  const settings = await getSettings();
  if (!settings.enabled) return [];

  const inboxes = await messenger.folders.query({ specialUse: ["inbox"] });
  if (!inboxes.length) return [];

  const now = Date.now();
  const stored = await messenger.storage.local.get("lastInboxScanAt");
  const previousScan = stored.lastInboxScanAt
    ? new Date(stored.lastInboxScanAt).getTime()
    : now - INBOX_SCAN_INITIAL_LOOKBACK_MS;
  const listed = await messenger.messages.query({
    folderId: inboxes.map((inbox) => inbox.id),
    fromDate: new Date(previousScan - INBOX_SCAN_OVERLAP_MS),
    messagesPerPage: 100,
  });
  const headers = await collectMessageList(listed);
  const candidates = headers.filter(
    (header) => !hasClassificationTag(header),
  );

  candidates.sort((left, right) => new Date(right.date) - new Date(left.date));
  const selected = candidates.slice(0, INBOX_SCAN_LIMIT);
  const results = await enqueueIndividually(selected, "inbox-scan");
  if (candidates.length <= INBOX_SCAN_LIMIT && results.length === selected.length) {
    await messenger.storage.local.set({
      lastInboxScanAt: new Date(now).toISOString(),
    });
  }
  return results;
}

function scheduleInboxScan(delay = 0) {
  if (inboxScanPromise) return;
  inboxScanPromise = new Promise((resolve) => setTimeout(resolve, delay))
    .then(scanUnclassifiedInboxes)
    .catch(console.error)
    .finally(() => {
      inboxScanPromise = undefined;
    });
}

async function triageInitialView() {
  const stored = await messenger.storage.local.get("initialTriageVersion");
  if ((stored.initialTriageVersion ?? 0) >= INITIAL_TRIAGE_VERSION) return;

  const activeTabs = await messenger.mailTabs.query({
    active: true,
    currentWindow: true,
  });
  const currentWindowTabs = activeTabs.length
    ? activeTabs
    : await messenger.mailTabs.query({ currentWindow: true });
  const allMailTabs = currentWindowTabs.length
    ? currentWindowTabs
    : await messenger.mailTabs.query({});
  const tab = allMailTabs[0];
  if (!tab) return;

  const listed = await messenger.mailTabs.getListedMessages(tab.id, {
    sortType: "date",
    sortOrder: "descending",
  });
  const visibleHeaders = (listed.messages ?? []).slice(0, INITIAL_TRIAGE_LIMIT);
  const settings = await getSettings();
  if (settings.enabled) {
    await ensureTags(settings);
    for (const header of visibleHeaders.filter(hasClassificationTag)) {
      try {
        await detectAndTagEvent(header);
      } catch (error) {
        console.error("Failed to detect an event", header.id, error);
      }
    }
    const unclassified = visibleHeaders.filter(
      (header) => !hasClassificationTag(header),
    );
    await enqueueIndividually(unclassified, "initial-view");
  }
  await messenger.storage.local.set({
    initialTriageVersion: INITIAL_TRIAGE_VERSION,
  });
}

async function selectedOrDisplayedHeaders(tabId, suppliedMessages) {
  if (suppliedMessages) {
    const supplied = await collectMessageList(suppliedMessages);
    if (supplied.length) return supplied;
  }
  try {
    const selected = await messenger.mailTabs.getSelectedMessages();
    const headers = await collectMessageList(selected);
    if (headers.length) return headers;
  } catch {
    // A standalone message window has no active mail tab.
  }
  try {
    let resolvedTabId = tabId;
    if (resolvedTabId == null) {
      const [tab] = await messenger.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      resolvedTabId = tab?.id;
    }
    if (resolvedTabId == null) return [];
    return collectMessageList(
      await messenger.messageDisplay.getDisplayedMessages(resolvedTabId),
    );
  } catch {
    return [];
  }
}

async function createCalendarEvent(event, calendarId = "") {
  const calendarData = createIcs(event);
  const created = await messenger.calendarBridge.create(calendarData, calendarId);
  if (created?.calendar?.id) {
    await messenger.storage.local.set({
      defaultCalendarId: created.calendar.id,
    });
  }
  return created;
}

async function notifyEventResult(title, message) {
  try {
    await messenger.notifications.create({
      type: "basic",
      iconUrl: messenger.runtime.getURL("icons/calendar.svg"),
      title,
      message,
    });
  } catch (error) {
    console.warn("Local Triage could not show a calendar notification", error);
  }
}

async function eventDetailsForInteraction(header) {
  try {
    return await withTimeout(
      detectAndTagEvent(header, true),
      INTERACTIVE_EVENT_WAIT_TIMEOUT_MS,
      "Detailed event generation is still running in the background",
    );
  } catch (error) {
    const event = await performEventDetection(
      header,
      true,
      undefined,
      undefined,
      false,
    );
    event.enrichmentCache = "interactive-fallback";
    event.enrichmentError = String(error?.message ?? error);
    await storeEventDiagnostics(header, event);
    return event;
  }
}

async function openEventReviewForMessages(headers, tabId) {
  if (headers.length !== 1) {
    await notifyEventResult(
      "Calendar event review unavailable",
      headers.length
        ? "Select exactly one message."
        : "Select or open a message first.",
    );
    return { ok: false, error: "Select exactly one message." };
  }

  pendingEventReviewTarget = {
    messageId: headers[0].id,
    tabId: Number.isInteger(tabId) ? tabId : undefined,
    expiresAt: Date.now() + 30 * 1000,
  };
  try {
    const opened = await messenger.action.openPopup();
    if (!opened) {
      throw new Error(
        "Keep the Local Triage button in Thunderbird's unified toolbar so its event review can open.",
      );
    }
    return { ok: true };
  } catch (error) {
    pendingEventReviewTarget = undefined;
    const message = String(error?.message ?? error);
    await notifyEventResult("Calendar event review unavailable", message);
    return { ok: false, error: message };
  }
}

async function eventHeadersForRequest(request) {
  if (Number.isInteger(request?.messageId)) {
    try {
      return [await messenger.messages.get(request.messageId)];
    } catch {
      // The message may have moved after the action was opened; resolve it from
      // the active reader as a fallback.
    }
  }
  return selectedOrDisplayedHeaders(request?.tabId);
}

function registerCreateEventMenu() {
  try {
    messenger.menus.create({
      id: CREATE_EVENT_MENU_ID,
      title: "Create calendar event",
      contexts: ["message_list", "page", "selection"],
      icons: { 16: "icons/calendar.svg" },
      visible: false,
    });
  } catch (error) {
    console.warn("Local Triage could not register its calendar menu", error);
  }
}

async function updateCreateEventMenu(info, tab) {
  const headers = await selectedOrDisplayedHeaders(tab?.id, info.selectedMessages);
  const visible = headers.length === 1 &&
    (headers[0].tags ?? []).includes(EVENT_TAG.key);
  await messenger.menus.update(CREATE_EVENT_MENU_ID, { visible });
  await messenger.menus.refresh();
}

function scheduleInitialTriage() {
  if (initialTriagePromise) return;
  initialTriagePromise = new Promise((resolve) => setTimeout(resolve, 2500))
    .then(triageInitialView)
    .catch(console.error)
    .finally(() => {
      initialTriagePromise = undefined;
    });
}

function scheduleInterruptedEventModelRecovery(observedStatus) {
  if (eventModelRecoveryTimer) clearTimeout(eventModelRecoveryTimer);
  const updatedAt = Date.parse(observedStatus.updatedAt ?? "");
  const age = Number.isFinite(updatedAt) ? Date.now() - updatedAt : 0;
  const delay = Math.max(0, EVENT_MODEL_RECOVERY_GRACE_MS - age);
  eventModelRecoveryTimer = setTimeout(async () => {
    eventModelRecoveryTimer = undefined;
    if (isEventModelBusy()) return;
    const { eventModelStatus: current } = await messenger.storage.local.get(
      "eventModelStatus",
    );
    if (
      current?.state !== "loading" ||
      current.updatedAt !== observedStatus.updatedAt
    ) return;
    await messenger.storage.local.set({
      eventModelStatus: {
        ...current,
        state: "idle",
        phase: "interrupted",
        detail: "The previous model preparation was interrupted. Click Download and test event model to resume from the local cache.",
        updatedAt: new Date().toISOString(),
      },
    });
  }, delay);
}

async function initializeEventModelState() {
  const { eventModelStatus } = await messenger.storage.local.get(
    "eventModelStatus",
  );
  if (
    eventModelStatus &&
    (
      eventModelStatus.modelId !== EVENT_MODEL_ID ||
      eventModelStatus.runtimeVersion !== EVENT_MODEL_RUNTIME_VERSION
    )
  ) {
    await messenger.storage.local.set({
      eventModelStatus: {
        state: "idle",
        phase: "model-changed",
        detail: "The event model runtime has been upgraded. Click Download and test event model to prepare the native CPU backend.",
        modelId: EVENT_MODEL_ID,
        runtimeVersion: EVENT_MODEL_RUNTIME_VERSION,
        updatedAt: new Date().toISOString(),
      },
    });
    return;
  }
  if (eventModelStatus?.state === "loading") {
    scheduleInterruptedEventModelRecovery(eventModelStatus);
    return;
  }
  // A persisted ready state means the weights are cached, not that a fresh
  // native process needs to load them immediately. Qwen is intentionally
  // prepared only when an event action or its explicit Settings test needs it;
  // otherwise it can delay the lightweight embedding model used by startup
  // triage on the shared native worker.
}

addExtensionListener(messenger.messages?.onNewMailReceived, "messages.onNewMailReceived", (_folder, messageList) => {
  collectMessageList(messageList)
    .then((headers) =>
      enqueueIndividually(
        headers.filter((header) => !hasClassificationTag(header)),
        "automatic",
      ),
    )
    .catch(console.error);
});

addExtensionListener(messenger.messageDisplay?.onMessagesDisplayed, "messageDisplay.onMessagesDisplayed", (tab, messageList) => {
  updateDisplayedEventActions(tab.id, messageList).catch(console.error);
});

addExtensionListener(messenger.calendarBridge?.onActionClicked, "calendarBridge.onActionClicked", (details) => {
  const headers = Number.isInteger(details.messageId)
    ? messenger.messages.get(details.messageId).then((header) => [header])
    : selectedOrDisplayedHeaders(details.tabId);
  headers
    .then((resolved) => openEventReviewForMessages(resolved, details.tabId))
    .catch(console.error);
});

addExtensionListener(messenger.menus?.onClicked, "menus.onClicked", (info, tab) => {
  if (info.menuItemId !== CREATE_EVENT_MENU_ID) return;
  selectedOrDisplayedHeaders(tab?.id, info.selectedMessages)
    .then((headers) => openEventReviewForMessages(headers, tab?.id))
    .catch(console.error);
});

addExtensionListener(messenger.menus?.onShown, "menus.onShown", (info, tab) => {
  updateCreateEventMenu(info, tab).catch(console.error);
});

addExtensionListener(messenger.runtime?.onInstalled, "runtime.onInstalled", () => {
  scheduleInitialTriage();
  scheduleInboxScan(5000);
});
addExtensionListener(messenger.runtime?.onStartup, "runtime.onStartup", () => {
  scheduleInitialTriage();
  scheduleInboxScan(5000);
});

addExtensionListener(messenger.messages?.onUpdated, "messages.onUpdated", (_message, changedProperties) => {
  if (typeof changedProperties.read === "boolean") {
    messenger.smartOrder?.refresh?.()?.catch?.(console.error);
  }
});

addExtensionListener(messenger.alarms?.onAlarm, "alarms.onAlarm", (alarm) => {
  if (alarm.name === "refresh-smart-order") {
    messenger.smartOrder?.refresh?.()?.catch?.(console.error);
  }
  if (alarm.name === "scan-unclassified-mail") {
    scheduleInboxScan();
  }
});

async function handleRuntimeMessage(request) {
  switch (request?.type) {
    case "ping":
      return {
        ok: true,
        extensionVersion: messenger.runtime.getManifest().version,
      };
    case "classify-selected": {
      const headers = await selectedOrDisplayedHeaders();
      if (!headers.length) {
        return { ok: true, results: [], errors: [] };
      }
      const results = await enqueue(headers, "selected");
      const { runStatus } = await messenger.storage.local.get("runStatus");
      const errors = runStatus?.source === "selected" ? runStatus.errors ?? [] : [];
      return { ok: errors.length === 0, results, errors };
    }
    case "detect-event-selected": {
      const headers = await eventHeadersForRequest(request);
      if (headers.length !== 1) {
        return {
          ok: false,
          error: headers.length
            ? "Select exactly one message to create an event."
            : "Select or open a message first.",
        };
      }
      await ensureTags(await getSettings());
      const event = await eventDetailsForInteraction(headers[0]);
      await setDetectedEventAction(headers[0], event.detected, request.tabId);
      return { ok: true, event };
    }
    case "probe-event-selected": {
      const headers = await eventHeadersForRequest(request);
      if (headers.length !== 1) {
        return { ok: false, detected: false };
      }
      await ensureTags(await getSettings());
      const event = await detectAndTagEvent(headers[0], false);
      await setDetectedEventAction(headers[0], event.detected, request.tabId);
      return { ok: true, detected: event.detected, event };
    }
    case "prepare-event-review-selected": {
      try {
        const headers = await eventHeadersForRequest(request);
        if (headers.length !== 1) {
          return {
            ok: false,
            error: headers.length
              ? "Select exactly one message to create an event."
              : "Select or open a message first.",
          };
        }
        await ensureTags(await getSettings());
        const event = await eventDetailsForInteraction(headers[0]);
        await setDetectedEventAction(headers[0], event.detected, request.tabId);
        let calendars;
        let calendarWarning;
        try {
          calendars = await messenger.calendarBridge.list();
        } catch (error) {
          calendarWarning = String(error?.message ?? error);
          calendars = [{
            id: "",
            name: "Default Thunderbird calendar",
            color: "#4c63d2",
            visible: true,
          }];
        }
        const { defaultCalendarId = "" } = await messenger.storage.local.get(
          "defaultCalendarId",
        );
        return {
          ok: true,
          event,
          calendars,
          defaultCalendarId,
          calendarWarning,
        };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    case "claim-event-review-target": {
      const target = pendingEventReviewTarget;
      pendingEventReviewTarget = undefined;
      if (!target || target.expiresAt < Date.now()) {
        return { ok: true, target: null };
      }
      return {
        ok: true,
        target: {
          messageId: target.messageId,
          tabId: target.tabId,
        },
      };
    }
    case "list-calendars": {
      try {
        const calendars = await messenger.calendarBridge.list();
        const { defaultCalendarId } = await messenger.storage.local.get(
          "defaultCalendarId",
        );
        return { ok: true, calendars, defaultCalendarId };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    case "create-calendar-event": {
      try {
        const created = await createCalendarEvent(
          request.event,
          request.calendarId ?? "",
        );
        return { ok: true, created };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    case "self-test": {
      const settings = await getSettings();
      const result = await classify(
        {
          author: "project-lead@example.com",
          recipients: ["me@example.com"],
          subject: "Approval needed before today's release",
          body: "Please review the attached release plan and approve it before 4 PM today.",
          directRecipient: true,
          headers: {},
        },
        settings,
      );
      return {
        ok: true,
        result: {
          category: result.category.name,
          priority: result.priority.key,
          score: result.score,
          confidence: result.categoryConfidence,
          engine: result.engine,
          error: result.engine === "heuristic" ? result.reason : undefined,
        },
      };
    }
    case "event-model-self-test": {
      try {
        await clearEventModelDiagnostics();
        const model = await prepareEventModel();
        const result = await generateEventDetails({
          subject: "Engineering planning session",
          body: [
            "Please join the engineering planning workshop next Thursday.",
            "We will review staffing and release risks.",
            "The meeting is in The Shard, Level 12, from 14:00 to 16:00.",
          ].join("\n"),
          _diagnosticSafe: true,
        });
        return {
          ok: true,
          result: {
            engine: result._engine ?? model.engine,
            device: result._device ?? model.device,
            dtype: result._dtype ?? model.dtype,
            title: result.title,
            description: result.description,
            location: result.location,
          },
        };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    case "event-model-get-diagnostics": {
      try {
        return { ok: true, diagnostics: await getEventModelDiagnostics() };
      } catch (error) {
        const { eventModelDiagnostics } = await messenger.storage.local.get(
          "eventModelDiagnostics",
        );
        return {
          ok: Boolean(eventModelDiagnostics),
          diagnostics: eventModelDiagnostics,
          error: String(error?.message ?? error),
        };
      }
    }
    case "enable-smart-order":
      return { ok: await messenger.smartOrder.activateCurrent() };
    case "get-status":
      return messenger.storage.local.get([
        "runStatus",
        "modelStatus",
        "eventModelStatus",
      ]);
    default:
      return undefined;
  }
}

const LOCAL_TRIAGE_MESSAGE_TYPES = new Set([
  "classify-selected",
  "detect-event-selected",
  "probe-event-selected",
  "prepare-event-review-selected",
  "claim-event-review-target",
  "list-calendars",
  "create-calendar-event",
  "self-test",
  "event-model-self-test",
  "event-model-get-diagnostics",
  "enable-smart-order",
  "get-status",
]);

addExtensionListener(
  messenger.runtime?.onMessage,
  "runtime.onMessage",
  (request, _sender, sendResponse) => {
    if (request?.type === "ping") {
      sendResponse({
        ok: true,
        extensionVersion: messenger.runtime.getManifest().version,
      });
      return false;
    }
    if (!LOCAL_TRIAGE_MESSAGE_TYPES.has(request?.type)) return false;
    handleRuntimeMessage(request).then(
      sendResponse,
      (error) => sendResponse({
        ok: false,
        error: String(error?.message ?? error),
      }),
    );
    return true;
  },
  true,
);

addExtensionListener(messenger.storage?.onChanged, "storage.onChanged", (changes, areaName) => {
  if (areaName === "local" && changes.settings) {
    resetClassifier();
  }
});

runStartupTask("settings.ensureTags", () => getSettings().then(ensureTags));
runStartupTask("alarms.refresh-smart-order", () =>
  messenger.alarms?.create?.("refresh-smart-order", { periodInMinutes: 15 }));
runStartupTask("alarms.scan-unclassified-mail", () =>
  messenger.alarms?.create?.("scan-unclassified-mail", { periodInMinutes: 1 }));
runStartupTask("menus.create-event", registerCreateEventMenu);
runStartupTask("triage.initial-view", scheduleInitialTriage);
runStartupTask("triage.inbox-scan", () => scheduleInboxScan(5000));
setTimeout(() => runStartupTask(
  "events.scan-displayed",
  scanCurrentlyDisplayedMessages,
), 1000);
runStartupTask("event-model.initialize-state", initializeEventModelState);

localTriageBackgroundState.phase = "ready";
localTriageBackgroundState.readyAt = new Date().toISOString();
