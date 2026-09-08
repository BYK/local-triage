import test from "node:test";
import assert from "node:assert/strict";
import { categoryFromMetadata, classify } from "../src/classifier.js";
import { DEFAULT_SETTINGS } from "../src/defaults.js";

test("Turkish pension and investment mail is classified as finance", () => {
  const category = categoryFromMetadata(
    {
      subject: "Fon Koçu Ayın Fon Paketini Öneriyor!",
      body: "Emeklilik birikiminiz için yatırım fonu ve portföy önerisi.",
      author: "musterihizmetleri@example.com.tr",
      headers: {},
    },
    DEFAULT_SETTINGS,
  );

  assert.equal(category?.name, "Finance");
});

test("Turkish finance metadata also overrides the heuristic fallback", async () => {
  const result = await classify(
    {
      subject: "Fon Koçu Ayın Fon Paketini Öneriyor!",
      body: "Emeklilik birikiminiz için yatırım fonu ve portföy önerisi.",
      author: "musterihizmetleri@example.com.tr",
      headers: {},
    },
    { ...DEFAULT_SETTINGS, useEmbeddings: false },
  );

  assert.equal(result.category.name, "Finance");
  assert.equal(result.engine, "heuristic");
});
