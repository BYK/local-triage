import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/defaults.js";
import {
  cosineSimilarity,
  heuristicClassification,
  metadataAdjustment,
  priorityDateThreadKey,
  priorityForScore,
  priorityRank,
  softmax,
  timeAdjustedScore,
} from "../src/scoring.js";

test("cosine similarity identifies aligned vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("softmax returns probabilities summing to one", () => {
  const probabilities = softmax([0.2, 0.4, 0.1]);
  assert.ok(Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.equal(probabilities.indexOf(Math.max(...probabilities)), 1);
});

test("metadata adjustment boosts direct urgent requests", () => {
  const score = metadataAdjustment({
    subject: "URGENT: approval required today",
    body: "Please respond immediately.",
    author: "colleague@example.com",
    directRecipient: true,
    headers: { priority: "high" },
  });
  assert.ok(score >= 30);
});

test("metadata adjustment penalizes bulk mail", () => {
  const score = metadataAdjustment({
    subject: "Weekly newsletter sale",
    author: "no-reply@example.com",
    directRecipient: false,
    headers: { listUnsubscribe: "mailto:unsubscribe@example.com", precedence: "bulk" },
  });
  assert.ok(score <= -30);
});

test("heuristic fallback emits a complete classification", () => {
  const result = heuristicClassification(
    {
      subject: "Invoice payment is overdue — action required",
      body: "Please pay the attached invoice today.",
      author: "billing@example.com",
      directRecipient: true,
      headers: {},
    },
    DEFAULT_SETTINGS,
  );
  assert.ok(result.category.name);
  assert.ok(result.score >= 60);
  assert.match(result.priority.key, /^P[0-3]$/);
});

test("priority thresholds are monotonic", () => {
  assert.equal(priorityForScore(95).key, "P0");
  assert.equal(priorityForScore(70).key, "P1");
  assert.equal(priorityForScore(45).key, "P2");
  assert.equal(priorityForScore(10).key, "P3");
});

test("priority ranks map P0 through P3 in descending order", () => {
  assert.deepEqual(
    [priorityRank(80), priorityRank(60), priorityRank(35), priorityRank(0)],
    [3, 2, 1, 0],
  );
});

test("priority is a guardrail and recency separates equal scores", () => {
  const now = Date.parse("2026-08-02T00:00:00Z");
  const oldP1 = priorityDateThreadKey(
    [{ baseScore: 60, receivedAt: "2026-01-01T00:00:00Z" }],
    now,
  );
  const newP2 = priorityDateThreadKey(
    [{ baseScore: 50, receivedAt: "2026-08-01T00:00:00Z" }],
    now,
  );
  const newerP1 = priorityDateThreadKey(
    [{ baseScore: 60, receivedAt: "2026-08-01T00:00:00Z" }],
    now,
  );
  assert.ok(oldP1 > newP2);
  assert.ok(newerP1 > oldP1);
});

test("continuous score differentiates messages inside one priority", () => {
  const now = Date.parse("2026-08-02T00:00:00Z");
  assert.ok(
    timeAdjustedScore(75, "2026-08-01T00:00:00Z", now) >
      timeAdjustedScore(65, "2026-08-01T00:00:00Z", now),
  );
});
