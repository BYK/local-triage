import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const implementation = await readFile(
  new URL("../static/experiments/smart-order/implementation.js", import.meta.url),
  "utf8",
);

test("classification score storage survives a missing Thunderbird column API", async () => {
  const writes = [];
  const message = {
    folder: {
      msgDatabase: {
        commit: () => writes.push(["commit"]),
      },
    },
    setStringProperty: (key, value) => writes.push([key, value]),
  };
  const sandbox = {
    ChromeUtils: {
      importESModule: () => {
        throw new Error("module unavailable");
      },
    },
    Ci: { nsMsgDBCommitType: { kLargeCommit: 1 } },
    console: { warn: () => {} },
    ExtensionCommon: { ExtensionAPI: class {} },
    Services: {},
  };

  vm.runInNewContext(implementation, sandbox);
  const extension = new sandbox.smartOrder();
  const api = extension.getAPI({
    callOnClose: () => {},
    extension: {
      messageManager: { get: () => message },
    },
  }).smartOrder;

  await api.setScore(1, 72.5);
  await api.refresh();
  await assert.rejects(api.activateCurrent(), /classification remains active/);
  extension.close();

  assert.deepEqual(writes, [
    ["localTriageBaseScore", "72.5"],
    ["commit"],
  ]);
});
