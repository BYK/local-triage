import { DEFAULT_SETTINGS } from "./defaults.js";

const LEGACY_DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const LEGACY_FINANCE_DESCRIPTION =
  "Banking, payments, invoices, receipts, tax, insurance, subscriptions, purchases, or other financial matters.";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeSettings(value = {}) {
  const settings = { ...clone(DEFAULT_SETTINGS), ...value };
  if (settings.modelId === LEGACY_DEFAULT_MODEL_ID) {
    settings.modelId = DEFAULT_SETTINGS.modelId;
  }
  settings.categories = Array.isArray(value.categories)
    ? value.categories
        .filter((category) => category?.name && category?.description)
        .map((category, index) => {
          const name = String(category.name).trim();
          let description = String(category.description).trim();
          if (name === "Finance" && description === LEGACY_FINANCE_DESCRIPTION) {
            description = DEFAULT_SETTINGS.categories.find(
              (candidate) => candidate.name === "Finance",
            ).description;
          }
          return {
            name,
            description,
            color:
              /^#[0-9a-f]{6}$/i.test(category.color) && category.color
                ? category.color.toUpperCase()
                : DEFAULT_SETTINGS.categories[index % DEFAULT_SETTINGS.categories.length]
                    .color,
          };
        })
    : clone(DEFAULT_SETTINGS.categories);

  if (!settings.categories.length) {
    settings.categories = clone(DEFAULT_SETTINGS.categories);
  }

  settings.maximumBodyCharacters = Math.max(
    400,
    Math.min(8000, finiteNumber(settings.maximumBodyCharacters, 2400)),
  );
  settings.minimumCategoryConfidence = Math.max(
    0,
    Math.min(1, finiteNumber(settings.minimumCategoryConfidence, 0.3)),
  );
  return settings;
}

export async function getSettings() {
  const stored = await messenger.storage.local.get("settings");
  return normalizeSettings(stored.settings);
}

export async function saveSettings(value) {
  const settings = normalizeSettings(value);
  await messenger.storage.local.set({ settings });
  return settings;
}

export function categoriesToText(categories) {
  return categories
    .map(
      ({ name, description, color }) =>
        `${name} | ${description} | ${color}`,
    )
    .join("\n");
}

export function categoriesFromText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name, description, color] = line
        .split("|")
        .map((part) => part.trim());
      if (!name || !description) {
        throw new Error(`Invalid category on line ${index + 1}`);
      }
      return { name, description, color };
    });
}
