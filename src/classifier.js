import {
  embedNativeTexts,
  prepareNativeEmbeddingModel,
} from "./native-event-model-client.js";
import {
  clamp,
  cosineSimilarity,
  heuristicClassification,
  metadataAdjustment,
  priorityForScore,
  sigmoid,
  softmax,
} from "./scoring.js";
import { withTimeout } from "./timeout.js";

const IMPORTANT_ANCHOR =
  "An important or urgent email addressed to me that needs a response, decision, approval, payment, or concrete action soon and has meaningful consequences.";
const LOW_PRIORITY_ANCHOR =
  "A low-priority automated newsletter, marketing promotion, routine notification, social update, digest, advertisement, or informational message requiring no response.";
const TURKISH_FINANCE_PATTERN =
  /(?:^|[^\p{L}])(?:banka|bankacılık|emeklilik|yatırım|yatirim|fon|fatura|ödeme|odeme|sigorta|kredi|vergi|finans|hisse|tahvil|portföy|portfoy)(?=$|[^\p{L}])/iu;
const MODEL_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

let referenceVectorsPromise;
let referenceVectorsSignature;

function messageText(input, maximumBodyCharacters) {
  const body = (input.body ?? "").slice(0, maximumBodyCharacters);
  return [
    `Subject: ${input.subject ?? ""}`,
    `From: ${input.author ?? ""}`,
    `To: ${(input.recipients ?? []).join(", ")}`,
    `Message: ${body}`,
  ].join("\n");
}

function modelText(text, modelId) {
  return /multilingual-e5/i.test(modelId) ? `query: ${text}` : text;
}

export function categoryFromMetadata(input, settings) {
  const find = (name) =>
    settings.categories.find((category) => category.name === name);
  const subjectAndBody = `${input.subject ?? ""}\n${input.body ?? ""}`;
  if (TURKISH_FINANCE_PATTERN.test(subjectAndBody)) {
    return find("Finance");
  }
  if (
    input.headers?.listUnsubscribe ||
    /\b(bulk|list|junk)\b/i.test(input.headers?.precedence ?? "")
  ) {
    return find("Newsletter");
  }
  if (
    (input.headers?.autoSubmitted && !/^no$/i.test(input.headers.autoSubmitted)) ||
    /\b(no[-_.]?reply|donotreply)\b/i.test(input.author ?? "")
  ) {
    return find("Notification");
  }
  return undefined;
}

function applyMetadataCategory(result, input, settings) {
  const category = categoryFromMetadata(input, settings);
  if (!category) return result;
  return {
    ...result,
    category,
    categoryConfidence: 0.95,
  };
}

async function getReferenceVectors(settings) {
  const labels = settings.categories.map(
    (category) => `${category.name}: ${category.description}`,
  );
  const signature = JSON.stringify([
    settings.modelId,
    settings.modelDtype,
    labels,
  ]);
  if (!referenceVectorsPromise || referenceVectorsSignature !== signature) {
    referenceVectorsSignature = signature;
    referenceVectorsPromise = embedNativeTexts(
      [...labels, IMPORTANT_ANCHOR, LOW_PRIORITY_ANCHOR].map((text) =>
        modelText(text, settings.modelId),
      ),
      {
        modelId: settings.modelId,
        dtype: settings.modelDtype,
        maxLength: 256,
      },
    ).then(({ vectors }) => {
      return {
        categoryVectors: vectors.slice(0, labels.length),
        importantVector: vectors.at(-2),
        lowPriorityVector: vectors.at(-1),
      };
    });
  }
  return referenceVectorsPromise;
}

export async function classify(input, settings) {
  if (!settings.useEmbeddings) {
    return applyMetadataCategory(
      heuristicClassification(input, settings, "embedding model disabled"),
      input,
      settings,
    );
  }

  try {
    const deadline = Date.now() + MODEL_OPERATION_TIMEOUT_MS;
    const awaitModel = (operation, stage) =>
      withTimeout(
        operation,
        Math.max(1, deadline - Date.now()),
        `Local model timed out while ${stage}`,
      );
    await awaitModel(
      prepareNativeEmbeddingModel({
        modelId: settings.modelId,
        dtype: settings.modelDtype,
      }),
      "initializing",
    );
    const { categoryVectors, importantVector, lowPriorityVector } =
      await awaitModel(
        getReferenceVectors(settings),
        "preparing reference vectors",
      );
    const embedding = await awaitModel(
      embedNativeTexts(
        [modelText(
          messageText(input, settings.maximumBodyCharacters),
          settings.modelId,
        )],
        {
          modelId: settings.modelId,
          dtype: settings.modelDtype,
          maxLength: 256,
        },
      ),
      "classifying the message",
    );
    const [messageVector] = embedding.vectors;

    const similarities = categoryVectors.map((vector) =>
      cosineSimilarity(messageVector, vector),
    );
    const isMultilingualE5 = /multilingual-e5/i.test(settings.modelId);
    const probabilities = softmax(similarities, isMultilingualE5 ? 0.02 : 0.08);
    const candidates = settings.categories
      .map((category, index) => ({
        category,
        similarity: similarities[index],
        probability: probabilities[index],
      }))
      .sort((left, right) => right.probability - left.probability);

    const importantSimilarity = cosineSimilarity(messageVector, importantVector);
    const lowPrioritySimilarity = cosineSimilarity(messageVector, lowPriorityVector);
    const semanticPriority = sigmoid(
      (importantSimilarity - lowPrioritySimilarity) * 12,
    );
    const score = clamp(
      semanticPriority * 100 + metadataAdjustment(input),
      0,
      100,
    );

    const metadataCategory = categoryFromMetadata(input, settings);
    const selectedCategory = metadataCategory ?? candidates[0].category;
    const categoryConfidence = metadataCategory
      ? 0.95
      : candidates[0].probability;

    return {
      category: selectedCategory,
      categoryConfidence,
      categoryCandidates: candidates.slice(0, 3).map((candidate) => ({
        name: candidate.category.name,
        score: candidate.probability,
      })),
      score,
      priority: priorityForScore(score),
      engine: isMultilingualE5 ? "multilingual-e5" : "minilm",
      reason: "embedding similarity and message metadata",
    };
  } catch (error) {
    console.error("Local embedding classifier failed; using heuristic fallback", error);
    resetClassifier();
    await messenger.storage.local.set({
      modelStatus: {
        state: "error",
        error: String(error?.message ?? error),
        updatedAt: new Date().toISOString(),
      },
    });
    return applyMetadataCategory(
      heuristicClassification(input, settings, String(error?.message ?? error)),
      input,
      settings,
    );
  }
}

export async function rankTextsByMeaning(texts, meaning, settings) {
  const candidates = [...new Set(
    texts.map((text) => String(text ?? "").trim()).filter(Boolean),
  )];
  if (!candidates.length || !settings.useEmbeddings) return candidates;

  await withTimeout(
    prepareNativeEmbeddingModel({
      modelId: settings.modelId,
      dtype: settings.modelDtype,
    }),
    MODEL_OPERATION_TIMEOUT_MS,
    "Local model timed out while preparing event details",
  );
  const isMultilingualE5 = /multilingual-e5/i.test(settings.modelId);
  const modelInputs = isMultilingualE5
    ? [`query: ${meaning}`, ...candidates.map((text) => `passage: ${text}`)]
    : [meaning, ...candidates];
  const embedding = await withTimeout(
    embedNativeTexts(modelInputs, {
      modelId: settings.modelId,
      dtype: settings.modelDtype,
      maxLength: 192,
    }),
    MODEL_OPERATION_TIMEOUT_MS,
    "Local model timed out while extracting event details",
  );
  const [meaningVector, ...candidateVectors] = embedding.vectors;
  return candidates
    .map((text, index) => ({
      text,
      score: cosineSimilarity(meaningVector, candidateVectors[index]),
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ text }) => text);
}

export function resetClassifier() {
  referenceVectorsPromise = undefined;
  referenceVectorsSignature = undefined;
}
