import test from "node:test";
import assert from "node:assert/strict";
import { TimeoutError, withTimeout } from "../src/timeout.js";

test("withTimeout returns operations that finish in time", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 50, "too slow"), "done");
});

test("withTimeout rejects stalled operations clearly", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, "too slow"),
    (error) => error instanceof TimeoutError && error.message === "too slow",
  );
});
