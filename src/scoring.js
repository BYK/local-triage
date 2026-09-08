import { PRIORITIES } from "./defaults.js";

const STOP_WORDS = new Set(
  "a an and are as at be by for from has have i in is it my of on or that the this to was we with you your".split(
    " ",
  ),
);

const URGENT_PATTERN =
  /\b(urgent|asap|immediately|critical|deadline|overdue|action required|respond today|due today|time[- ]sensitive)\b/i;
const LOW_VALUE_PATTERN =
  /\b(unsubscribe|newsletter|digest|promotion|sale|offer|marketing|weekly update|notification settings)\b/i;

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export function softmax(values, temperature = 0.08) {
  const scaled = values.map((value) => value / temperature);
  const maximum = Math.max(...scaled);
  const exponentials = scaled.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

export function priorityForScore(score) {
  return PRIORITIES.find((priority) => score >= priority.minimum) ?? PRIORITIES.at(-1);
}

export function metadataAdjustment(input) {
  let adjustment = 0;
  const subjectAndBody = `${input.subject ?? ""}\n${input.body ?? ""}`;

  if (input.directRecipient) adjustment += 7;
  if (input.headers?.priority === "high") adjustment += 10;
  if (input.headers?.priority === "highest") adjustment += 16;
  if (input.headers?.listUnsubscribe) adjustment -= 14;
  if (/\b(bulk|list|junk)\b/i.test(input.headers?.precedence ?? "")) adjustment -= 12;
  if (
    input.headers?.autoSubmitted &&
    !/^no$/i.test(input.headers.autoSubmitted)
  ) {
    adjustment -= 10;
  }
  if (/\b(no[-_.]?reply|donotreply)\b/i.test(input.author ?? "")) adjustment -= 8;
  if (URGENT_PATTERN.test(subjectAndBody)) adjustment += 16;
  if (LOW_VALUE_PATTERN.test(subjectAndBody)) adjustment -= 8;
  return adjustment;
}

function tokens(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function overlapScore(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / Math.sqrt((leftTokens.size || 1) * (rightTokens.size || 1));
}

export function heuristicClassification(input, settings, reason = "heuristic") {
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`;
  const scored = settings.categories.map((category, index) => ({
    category,
    score:
      overlapScore(text, `${category.name} ${category.description}`) +
      (index === 0 && /\?|please|could you|can you|need you|approval/i.test(text)
        ? 0.18
        : 0),
  }));
  scored.sort((left, right) => right.score - left.score);

  const urgent = URGENT_PATTERN.test(text);
  const lowValue = LOW_VALUE_PATTERN.test(text) || input.headers?.listUnsubscribe;
  let score = 48 + metadataAdjustment(input);
  if (urgent) score += 18;
  if (lowValue) score -= 18;
  score = Math.round(clamp(score, 0, 100));

  return {
    category: scored[0].category,
    categoryConfidence: clamp(0.24 + scored[0].score, 0.15, 0.88),
    categoryCandidates: scored.slice(0, 3).map(({ category, score: value }) => ({
      name: category.name,
      score: value,
    })),
    score,
    priority: priorityForScore(score),
    engine: "heuristic",
    reason,
  };
}

const PRIORITY_DATE_STEP = 1_000_000_000;
const PRIORITY_SCORE_SCALE = 1_000_000;

export function priorityRank(baseScore) {
  if (baseScore >= 80) return 3;
  if (baseScore >= 60) return 2;
  if (baseScore >= 35) return 1;
  return 0;
}

export function timeAdjustedScore(
  baseScore,
  receivedAt,
  now = Date.now(),
  halfLifeHours = 72,
) {
  const ageHours = Math.max(0, now - new Date(receivedAt).getTime()) / 3_600_000;
  return baseScore * Math.exp((-Math.log(2) * ageHours) / halfLifeHours);
}

export function priorityDateThreadKey(messages, now = Date.now()) {
  const maximumPriority = messages.reduce(
    (maximum, message) => Math.max(maximum, priorityRank(message.baseScore)),
    0,
  );
  const maximumAdjustedScore = messages.reduce(
    (maximum, message) =>
      priorityRank(message.baseScore) === maximumPriority
        ? Math.max(
            maximum,
            timeAdjustedScore(message.baseScore, message.receivedAt, now),
          )
        : maximum,
    0,
  );
  return (
    maximumPriority * PRIORITY_DATE_STEP +
    Math.round(maximumAdjustedScore * PRIORITY_SCORE_SCALE)
  );
}
