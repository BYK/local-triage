import { EVENT_TAG, PRIORITIES, REVIEW_TAG } from "./defaults.js";

const PREFIX = "localtriage-";

export function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function categoryTag(category) {
  return {
    key: `${PREFIX}category-${slug(category.name)}`,
    name: `✦ ${category.name}`,
    color: category.color,
  };
}

export function priorityTag(priority) {
  return {
    key: `${PREFIX}priority-${priority.key.toLowerCase()}`,
    name: `${priority.key} ${priority.name}`,
    color: priority.color,
  };
}

async function ensureTag(tag, existing) {
  const current = existing.get(tag.key);
  if (current) {
    const legacyNameCollision =
      current.tag !== tag.name &&
      [...existing.values()].some(
        (candidate) =>
          candidate.key !== current.key && candidate.tag === current.tag,
      );
    if (legacyNameCollision) {
      await messenger.messages.tags.delete(tag.key);
      await messenger.messages.tags.create(tag.key, tag.name, tag.color);
      existing.set(tag.key, tag);
      return;
    }
    if (
      current.tag !== tag.name ||
      current.color.toUpperCase() !== tag.color.toUpperCase()
    ) {
      await messenger.messages.tags.update(tag.key, {
        tag: tag.name,
        color: tag.color,
      });
      existing.set(tag.key, { ...current, tag: tag.name, color: tag.color });
    }
    return;
  }
  try {
    await messenger.messages.tags.create(tag.key, tag.name, tag.color);
    existing.set(tag.key, tag);
  } catch (error) {
    const refreshed = await messenger.messages.tags.list();
    if (!refreshed.some((candidate) => candidate.key === tag.key)) throw error;
    existing.set(tag.key, refreshed.find((candidate) => candidate.key === tag.key));
  }
}

export function hasClassificationTag(header) {
  return (header.tags ?? []).some((tag) =>
    tag.startsWith(`${PREFIX}category-`),
  );
}

export async function ensureTags(settings) {
  const existing = new Map(
    (await messenger.messages.tags.list()).map((tag) => [tag.key, tag]),
  );
  for (const category of settings.categories) {
    await ensureTag(categoryTag(category), existing);
  }
  for (const priority of PRIORITIES) {
    await ensureTag(priorityTag(priority), existing);
  }
  await ensureTag(REVIEW_TAG, existing);
  await ensureTag(EVENT_TAG, existing);
}

export async function applyClassification(
  header,
  result,
  settings,
  eventDetected = false,
) {
  await ensureTags(settings);
  const retained = (header.tags ?? []).filter((tag) => !tag.startsWith(PREFIX));
  const additions = [
    categoryTag(result.category).key,
    priorityTag(result.priority).key,
  ];
  if (result.categoryConfidence < settings.minimumCategoryConfidence) {
    additions.push(REVIEW_TAG.key);
  }
  if (eventDetected) additions.push(EVENT_TAG.key);

  const properties = { tags: [...new Set([...retained, ...additions])] };
  if (settings.starUrgent && result.priority.key === "P0" && !header.flagged) {
    properties.flagged = true;
  }
  await messenger.messages.update(header.id, properties);
}

export async function applyEventTag(header, detected) {
  const current = header.tags ?? [];
  const withoutEvent = current.filter((tag) => tag !== EVENT_TAG.key);
  const tags = detected ? [...withoutEvent, EVENT_TAG.key] : withoutEvent;
  if (tags.length === current.length && tags.every((tag, index) => tag === current[index])) {
    return;
  }
  await messenger.messages.update(header.id, { tags });
}
