"use strict";

var cal;
var CalEvent;
var ExtensionError;
var calendarBridgeFailure;
try {
  ({ ExtensionError } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs",
  ));
} catch (error) {
  console.warn("Local Triage could not load ExtensionError", error);
}
try {
  ({ cal } = ChromeUtils.importESModule(
    "resource:///modules/calendar/calUtils.sys.mjs",
  ));
  ({ CalEvent } = ChromeUtils.importESModule(
    "resource:///modules/CalEvent.sys.mjs",
  ));
} catch (error) {
  calendarBridgeFailure = error;
  console.warn(
    "Local Triage calendar creation is unavailable; mail triage will continue",
    error,
  );
}

function publicCalendarError(operation, error) {
  const detail = error?.message || error?.resultName || String(error);
  const message = `${operation}: ${detail}`;
  return ExtensionError ? new ExtensionError(message) : new Error(message);
}

function writableCalendars() {
  if (!cal) {
    throw new Error(
      `Thunderbird Calendar is unavailable: ${calendarBridgeFailure?.message ?? "calendar modules could not be loaded"}`,
    );
  }
  return cal.manager
    .getCalendars()
    .filter((calendar) =>
      !calendar.readOnly &&
      !calendar.getProperty("disabled") &&
      calendar.getProperty("capabilities.events.supported") !== false,
    )
    .sort((left, right) =>
      Number(Boolean(right.getProperty("calendar-main-in-composite"))) -
      Number(Boolean(left.getProperty("calendar-main-in-composite"))),
    );
}

function calendarDetails(calendar) {
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.getProperty("color") || "#4c63d2",
    visible: Boolean(calendar.getProperty("calendar-main-in-composite")),
  };
}

function eventFromIcs(ics) {
  try {
    const item = new CalEvent(ics);
    if (!item.startDate || !item.title) {
      throw new Error("the generated event is missing its title or start date");
    }
    return item;
  } catch (error) {
    throw new Error(`Could not parse the generated event: ${error.message}`);
  }
}

const CONVERSATIONS_URI_PREFIX = "chrome://conversations/";
const CONVERSATIONS_ACTION_ATTRIBUTE = "data-local-triage-calendar-action";
const EVENT_TAG_KEY = "localtriage-event";

function hasEventTag(header) {
  if (!header) return false;
  try {
    return String(header.getStringProperty("keywords") ?? "")
      .split(/\s+/)
      .includes(EVENT_TAG_KEY);
  } catch {
    return false;
  }
}

function displayedHeader(readerWindow) {
  const candidates = [
    readerWindow?.gMessage,
    readerWindow?.messageBrowser?.contentWindow?.gMessage,
    readerWindow?.messageBrowser?.contentDocument?.defaultView?.gMessage,
  ];
  try {
    candidates.unshift(...(readerWindow?.gDBView?.getSelectedMsgHdrs?.() ?? []));
  } catch {
    // Standalone message windows do not have a thread-tree selection.
  }
  return candidates.find(Boolean);
}

function widgetId(extensionId) {
  return String(extensionId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function calendarSvg(document) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.25");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.cssText = "display:block;flex:none;opacity:.82;pointer-events:none";
  const calendar = document.createElementNS("http://www.w3.org/2000/svg", "path");
  calendar.setAttribute(
    "d",
    "M7 3v3m10-3v3M5 9h14M7 5h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  );
  const plus = document.createElementNS("http://www.w3.org/2000/svg", "path");
  plus.setAttribute("d", "M12 12v5m-2.5-2.5h5");
  svg.append(calendar, plus);
  return svg;
}

function tabKey(tabId) {
  return Number.isInteger(tabId) ? tabId : -1;
}

function eventActionVisible(detectedIds, header) {
  return Boolean(detectedIds?.length) || hasEventTag(header);
}

var calendarBridge = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    this.context = context;
    this.actionListeners ??= new Set();
    this.documentObservers ??= new Map();
    this.nativeActionOriginalState ??= new Map();
    this.detectedMessageIds ??= new Map();
    this.nativeActionId =
      `${widgetId(context.extension.id)}-messageDisplayAction-toolbarbutton`;
    try {
      this.startConversationDiscovery();
    } catch (error) {
      calendarBridgeFailure ??= error;
      console.warn(
        "Local Triage could not initialize its Conversations integration; calendar creation will remain available elsewhere",
        error,
      );
    }
    context.callOnClose(this);

    return {
      calendarBridge: {
        async list() {
          try {
            return writableCalendars().map(calendarDetails);
          } catch (error) {
            throw publicCalendarError("Could not read Thunderbird calendars", error);
          }
        },
        async create(ics, preferredCalendarId) {
          try {
            const calendars = writableCalendars();
            const calendar = calendars.find(
              (candidate) => candidate.id === preferredCalendarId,
            ) ?? calendars[0];
            if (!calendar) {
              throw new Error("No writable Thunderbird calendar is available.");
            }

            const item = eventFromIcs(ics);
            item.calendar = calendar;
            const created = await calendar.addItem(item);
            if (!created?.id) {
              throw new Error(
                `Thunderbird did not confirm that “${calendar.name}” accepted the event.`,
              );
            }
            return {
              id: created.id,
              calendar: calendarDetails(calendar),
              title: created?.title ?? item.title,
            };
          } catch (error) {
            throw publicCalendarError("Could not create the Thunderbird event", error);
          }
        },
        async setDetectedMessages(tabId, messageIds) {
          bridge.setDetectedMessages(tabId, messageIds);
        },
        onActionClicked: new ExtensionCommon.EventManager({
          context,
          name: "calendarBridge.onActionClicked",
          register: (fire) => {
            this.actionListeners.add(fire);
            return () => this.actionListeners.delete(fire);
          },
        }).api(),
      },
    };
  }

  startConversationDiscovery() {
    if (this.discoveryTimer) return;
    try {
      this.scanConversationReaders();
    } catch (error) {
      console.warn("Local Triage Conversations discovery failed", error);
    }
    this.discoveryTimer = setInterval(
      () => {
        try {
          this.scanConversationReaders();
        } catch (error) {
          console.warn("Local Triage Conversations discovery failed", error);
        }
      },
      1000,
    );
  }

  scanConversationReaders() {
    if (!this.context) return;
    const seenDocuments = new Set();

    for (const window of Services.wm.getEnumerator("mail:3pane")) {
      const tabmail = window.document.getElementById("tabmail");
      for (const tab of tabmail?.tabInfo ?? []) {
        const readerWindow = tab.chromeBrowser?.contentWindow;
        const messageBrowser = readerWindow?.multiMessageBrowser;
        let tabId;
        try {
          tabId = this.context.extension.tabManager.convert(tab).id;
        } catch {
          continue;
        }
        this.updateNativeAction(readerWindow, tabId);
        this.observeConversationDocument(
          messageBrowser?.contentDocument,
          tabId,
          seenDocuments,
          readerWindow,
        );
      }
    }

    for (const window of Services.wm.getEnumerator("mail:messageWindow")) {
      const messageBrowser =
        window.document.getElementById("multiMessageBrowser") ??
        window.multiMessageBrowser;
      this.updateNativeAction(window, -1);
      this.observeConversationDocument(
        messageBrowser?.contentDocument,
        undefined,
        seenDocuments,
        window,
      );
    }

    for (const [document, record] of this.documentObservers) {
      if (seenDocuments.has(document)) continue;
      record.observer.disconnect();
      this.removeConversationButtons(document);
      this.documentObservers.delete(document);
    }
  }

  observeConversationDocument(document, tabId, seenDocuments, readerWindow) {
    if (
      !document?.documentURI?.startsWith(CONVERSATIONS_URI_PREFIX) ||
      !document.documentElement
    ) {
      return;
    }
    seenDocuments.add(document);
    const existing = this.documentObservers.get(document);
    if (existing) {
      existing.tabId = tabId;
      existing.readerWindow = readerWindow;
      this.injectConversationButton(document, tabId, readerWindow);
      return;
    }

    const observer = new document.defaultView.MutationObserver(() => {
      const record = this.documentObservers.get(document);
      this.injectConversationButton(
        document,
        record?.tabId,
        record?.readerWindow,
      );
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    this.documentObservers.set(document, { observer, tabId, readerWindow });
    this.injectConversationButton(document, tabId, readerWindow);
  }

  injectConversationButton(document, tabId, readerWindow) {
    const actionGroup = document
      .querySelector("conversation-header")
      ?.shadowRoot
      ?.querySelector("conv-actions-buttons");
    const root = actionGroup?.shadowRoot;
    if (!root) return;

    let button = root.querySelector(`[${CONVERSATIONS_ACTION_ATTRIBUTE}]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "button-flat actions-button";
      button.setAttribute(CONVERSATIONS_ACTION_ATTRIBUTE, "true");
      button.setAttribute("aria-label", "Create calendar event");
      button.title = "Review detected event";
      button.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "padding:0",
        "margin:0",
        "line-height:1",
        "vertical-align:middle",
      ].join(";");
      button.appendChild(calendarSvg(document));
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const record = this.documentObservers.get(document);
        const header = displayedHeader(record?.readerWindow);
        const detectedIds = this.detectedMessageIds.get(tabKey(record?.tabId));
        if (!detectedIds?.length && !hasEventTag(header)) return;
        const details = {};
        if (Number.isInteger(record?.tabId)) details.tabId = record.tabId;
        if (detectedIds?.length) {
          details.messageId = detectedIds[0];
        } else {
          try {
            details.messageId =
              this.context.extension.messageManager.convert(header).id;
          } catch {
            // The background can resolve the selected message from the tab.
          }
        }
        for (const fire of this.actionListeners) fire.async(details);
      });
      root.insertBefore(button, root.querySelector(".archive"));
    }

    const detectedIds = this.detectedMessageIds.get(tabKey(tabId));
    const visible = eventActionVisible(
      detectedIds,
      displayedHeader(readerWindow),
    );
    button.hidden = !visible;
    button.classList.toggle("hidden", !visible);
    button.style.display = visible ? "" : "none";
  }

  updateNativeAction(readerWindow, tabId) {
    const header = displayedHeader(readerWindow);
    const detectedIds = this.detectedMessageIds.get(tabKey(tabId));
    const visible = eventActionVisible(detectedIds, header);
    const documents = [
      readerWindow?.document,
      readerWindow?.messageBrowser?.contentDocument,
      readerWindow?.messageBrowser?.contentWindow?.document,
    ].filter(Boolean);
    for (const document of new Set(documents)) {
      const button = document.getElementById(this.nativeActionId);
      if (!button) continue;
      if (!this.nativeActionOriginalState.has(button)) {
        this.nativeActionOriginalState.set(button, {
          hidden: button.hidden,
          display: button.style.getPropertyValue("display"),
          displayPriority: button.style.getPropertyPriority("display"),
        });
      }
      button.hidden = !visible;
      if (visible) {
        button.style.removeProperty("display");
      } else {
        button.style.setProperty("display", "none", "important");
      }
    }
  }

  setDetectedMessages(tabId, messageIds) {
    const ids = Array.isArray(messageIds)
      ? messageIds.filter(Number.isInteger)
      : [];
    this.detectedMessageIds.set(tabKey(tabId), ids);
    try {
      this.scanConversationReaders();
    } catch (error) {
      console.warn("Local Triage could not refresh Conversations actions", error);
    }
  }

  removeConversationButtons(document) {
    document
      .querySelector("conversation-header")
      ?.shadowRoot
      ?.querySelector("conv-actions-buttons")
      ?.shadowRoot
      ?.querySelector(`[${CONVERSATIONS_ACTION_ATTRIBUTE}]`)
      ?.remove();
  }

  close() {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = undefined;
    for (const [document, record] of this.documentObservers ?? []) {
      record.observer.disconnect();
      this.removeConversationButtons(document);
    }
    this.documentObservers?.clear();
    for (const [button, original] of this.nativeActionOriginalState ?? []) {
      button.hidden = original.hidden;
      if (original.display) {
        button.style.setProperty(
          "display",
          original.display,
          original.displayPriority,
        );
      } else {
        button.style.removeProperty("display");
      }
    }
    this.nativeActionOriginalState?.clear();
    this.actionListeners?.clear();
    this.detectedMessageIds?.clear();
    this.context = undefined;
  }
};
