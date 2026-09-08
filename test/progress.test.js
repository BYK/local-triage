import test from "node:test";
import assert from "node:assert/strict";
import { updateMonotonicDownloadPercent } from "../src/progress.js";

test("native model download progress never moves backward", () => {
  let percent;
  percent = updateMonotonicDownloadPercent(percent, {
    phase: "native-loading",
  });
  percent = updateMonotonicDownloadPercent(percent, {
    phase: "native-download",
    percent: 8,
  });
  percent = updateMonotonicDownloadPercent(percent, {
    phase: "native-download",
    percent: 6,
  });
  assert.equal(percent, 8);

  percent = updateMonotonicDownloadPercent(percent, {
    phase: "native-initializing",
  });
  assert.equal(percent, 8);

  percent = updateMonotonicDownloadPercent(percent, { phase: "ready" });
  assert.equal(percent, 100);
});
