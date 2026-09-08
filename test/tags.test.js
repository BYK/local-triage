import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEventTag,
  categoryTag,
  ensureTags,
  hasClassificationTag,
  priorityTag,
} from "../src/tags.js";
import { EVENT_TAG, PRIORITIES, REVIEW_TAG } from "../src/defaults.js";

test("visible tag labels do not expose the internal namespace", () => {
  const category = categoryTag({ name: "Finance", color: "#168A65" });
  const priority = priorityTag({ key: "P2", name: "Normal", color: "#3974C6" });

  assert.equal(category.name, "✦ Finance");
  assert.equal(priority.name, "P2 Normal");
  assert.match(category.key, /^localtriage-/);
  assert.match(priority.key, /^localtriage-/);
});

test("classified messages are recognized by internal keys", () => {
  assert.equal(
    hasClassificationTag({ tags: ["important", "localtriage-category-work"] }),
    true,
  );
  assert.equal(hasClassificationTag({ tags: ["important", "work"] }), false);
});

test("legacy duplicate tag names migrate without using the warning-prone update", async () => {
  const category = { name: "Work", color: "#4A78D0" };
  const desiredCategory = categoryTag(category);
  const existing = [
    { key: "$label1", tag: "Work", color: "#FF0000" },
    { ...desiredCategory, tag: "Work" },
    ...PRIORITIES.map((priority) => {
      const tag = priorityTag(priority);
      return { key: tag.key, tag: tag.name, color: tag.color };
    }),
    { key: REVIEW_TAG.key, tag: REVIEW_TAG.name, color: REVIEW_TAG.color },
    { key: EVENT_TAG.key, tag: EVENT_TAG.name, color: EVENT_TAG.color },
  ];
  const calls = [];
  globalThis.messenger = {
    messages: {
      tags: {
        list: async () => existing,
        delete: async (key) => calls.push(["delete", key]),
        create: async (key, tag, color) =>
          calls.push(["create", key, tag, color]),
        update: async (...arguments_) => calls.push(["update", ...arguments_]),
      },
    },
  };

  try {
    await ensureTags({ categories: [category] });
  } finally {
    delete globalThis.messenger;
  }

  assert.deepEqual(calls, [
    ["delete", desiredCategory.key],
    ["create", desiredCategory.key, desiredCategory.name, desiredCategory.color],
  ]);
});

test("event tagging preserves classification and user tags", async () => {
  const updates = [];
  globalThis.messenger = {
    messages: {
      update: async (...arguments_) => updates.push(arguments_),
    },
  };

  try {
    await applyEventTag(
      {
        id: 42,
        tags: ["important", "localtriage-category-finance"],
      },
      true,
    );
  } finally {
    delete globalThis.messenger;
  }

  assert.deepEqual(updates, [[42, {
    tags: ["important", "localtriage-category-finance", EVENT_TAG.key],
  }]]);
});
