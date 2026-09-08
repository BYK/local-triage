import test from "node:test";
import assert from "node:assert/strict";
import {
  categoriesFromText,
  categoriesToText,
  normalizeSettings,
} from "../src/settings.js";
import { DEFAULT_SETTINGS } from "../src/defaults.js";

test("category text round-trips", () => {
  const categories = [
    { name: "Work", description: "Professional correspondence", color: "#123456" },
  ];
  assert.deepEqual(categoriesFromText(categoriesToText(categories)), categories);
});

test("invalid category lines fail with a useful line number", () => {
  assert.throws(() => categoriesFromText("Missing description"), /line 1/);
});

test("settings enforce safe numeric bounds", () => {
  const settings = normalizeSettings({
    maximumBodyCharacters: 100_000,
    minimumCategoryConfidence: -2,
  });
  assert.equal(settings.maximumBodyCharacters, 8000);
  assert.equal(settings.minimumCategoryConfidence, 0);
});

test("zero is preserved as an explicit confidence threshold", () => {
  const settings = normalizeSettings({ minimumCategoryConfidence: 0 });
  assert.equal(settings.minimumCategoryConfidence, 0);
});

test("the former English-only default migrates to the multilingual model", () => {
  const settings = normalizeSettings({ modelId: "Xenova/all-MiniLM-L6-v2" });
  assert.equal(settings.modelId, DEFAULT_SETTINGS.modelId);
  assert.match(settings.modelId, /multilingual-e5/);
});

test("the default finance category gains investment vocabulary on upgrade", () => {
  const settings = normalizeSettings({
    categories: [
      {
        name: "Finance",
        description:
          "Banking, payments, invoices, receipts, tax, insurance, subscriptions, purchases, or other financial matters.",
        color: "#168A65",
      },
    ],
  });
  assert.match(settings.categories[0].description, /investments, pensions, funds/);
});
