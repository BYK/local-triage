import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../static/experiments/calendar-bridge/implementation.js", import.meta.url),
  "utf8",
);

class PublicExtensionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtensionError";
  }
}

function loadBridge() {
  const primaryCalendar = {
    id: "calendar-1",
    name: "Personal",
    readOnly: false,
    getProperty(name) {
      return {
        disabled: false,
        "capabilities.events.supported": true,
        "calendar-main-in-composite": true,
        color: "#123456",
      }[name];
    },
    async addItem(item) {
      return { ...item, id: "event-1" };
    },
  };
  const manager = {
    getCalendars: () => [primaryCalendar],
  };
  class CalEvent {
    constructor() {
      this.title = "Viewing confirmation";
      this.startDate = { isDate: false };
      this.endDate = {};
    }
  }
  class ExtensionAPI {}
  class EventManager {
    constructor({ register }) {
      this.register = register;
    }

    api() {
      return { addListener() {}, removeListener() {} };
    }
  }
  const sandbox = {
    ChromeUtils: {
      importESModule(uri) {
        if (uri.includes("ExtensionUtils")) {
          return { ExtensionError: PublicExtensionError };
        }
        if (uri.includes("calUtils")) return { cal: { manager } };
        if (uri.includes("CalEvent")) return { CalEvent };
        throw new Error(`Unexpected module: ${uri}`);
      },
    },
    ExtensionCommon: { ExtensionAPI, EventManager },
    Services: {
      wm: {
        getEnumerator: () => [],
        getMostRecentWindow: () => null,
      },
    },
    console,
    setInterval: () => 1,
    clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "calendar-bridge/implementation.js" });
  const instance = new sandbox.calendarBridge();
  const context = {
    extension: {
      id: "local-triage@byk.im",
      tabManager: { convert: () => ({ id: 1 }) },
      messageManager: { convert: () => ({ id: 42 }) },
    },
    callOnClose() {},
  };
  return {
    api: instance.getAPI(context).calendarBridge,
    manager,
    sandbox,
  };
}

test("an Event tag keeps the conditional calendar action visible", () => {
  const { sandbox } = loadBridge();
  const tagged = {
    getStringProperty: () => "localtriage-event localtriage-p2",
  };
  const untagged = { getStringProperty: () => "localtriage-p2" };

  assert.equal(sandbox.eventActionVisible([], tagged), true);
  assert.equal(sandbox.eventActionVisible(undefined, tagged), true);
  assert.equal(sandbox.eventActionVisible([42], untagged), true);
  assert.equal(sandbox.eventActionVisible([], untagged), false);
});

test("calendar bridge returns schema-safe calendar details", async () => {
  const { api } = loadBridge();
  assert.deepEqual(
    JSON.parse(JSON.stringify(await api.list())),
    [{
      id: "calendar-1",
      name: "Personal",
      color: "#123456",
      visible: true,
    }],
  );
});

test("calendar bridge exposes useful errors across the Experiment boundary", async () => {
  const { api, manager } = loadBridge();
  manager.getCalendars = () => {
    throw new Error("calendar manager broke");
  };

  await assert.rejects(
    api.list(),
    (error) =>
      error instanceof PublicExtensionError &&
      error.message === "Could not read Thunderbird calendars: calendar manager broke",
  );
});

test("event-creation failures are also public ExtensionErrors", async () => {
  const { api, manager } = loadBridge();
  manager.getCalendars()[0].addItem = async () => {
    throw new Error("calendar write failed");
  };
  await assert.rejects(
    api.create("BEGIN:VCALENDAR", "calendar-1"),
    (error) =>
      error instanceof PublicExtensionError &&
      /Could not create the Thunderbird event: calendar write failed/.test(error.message),
  );
});
